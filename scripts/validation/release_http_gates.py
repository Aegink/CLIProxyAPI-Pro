#!/usr/bin/env python3
"""Run existing real HTTP gates on release artifacts and the generated frontend."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback

from download_published_core import download, extract_binary, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--management', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--platform', default='linux_amd64', choices=['linux_amd64', 'darwin_aarch64', 'darwin_amd64'])
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    frontend = args.management.resolve()
    scripts = Path(__file__).resolve().parent
    receipt = {'passed': False, 'customizationSHA': os.environ.get('CUSTOMIZATION_SHA'),
               'coreUpstreamSHA': os.environ.get('CORE_SHA'),
               'modelsSHA': os.environ.get('MODELS_SHA'),
               'managementUpstreamSHA': os.environ.get('MANAGEMENT_SHA'),
               'management': str(frontend), 'productBinaries': [], 'commands': []}

    def run(name, command):
        record = {'name': name, 'command': [str(arg) for arg in command]}
        receipt['commands'].append(record)
        with (root / (name + '.log')).open('w') as log:
            completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
        record['exitCode'] = completed.returncode
        if completed.returncode:
            raise RuntimeError(f'{name} failed: see {name}.log and scenario receipt')

    def harness(name, binary, extra=()):
        run(name, [sys.executable, scripts / 'e2e' / name.split('-candidate')[0] / 'run.py',
                   '--binary', binary, '--output', root / name, *extra])

    try:
        asset = frontend / 'dist/index.html'
        receipt['managementAssetSha256'] = sha256(asset)
        archive = os.environ.get('CORE_CANDIDATE_ARCHIVE')
        candidate = None
        if archive:
            archive = Path(archive).resolve()
            candidate = root / 'candidate-core'
            extract_binary(archive, candidate)
            identity = {'role': 'candidate', 'tag': os.environ['CORE_CANDIDATE_TAG'],
                        'archiveSha256': sha256(archive), 'binarySha256': sha256(candidate)}
            receipt['productBinaries'].append(identity)
            harness('v8-config-http-candidate', candidate)
            harness('v8-usage-http-candidate', candidate)
            fixture = Path(os.environ['CORE_QUOTA_FIXTURE']).resolve()
            fixture_inputs = json.loads(fixture.with_name('quota-fixture-inputs.json').read_text())
            if fixture_inputs['binarySha256'] != sha256(fixture):
                raise ValueError('quota fixture binary differs from its source receipt')
            for env_key, receipt_key in [('CORE_SHA', 'coreUpstreamSHA'),
                                         ('CUSTOMIZATION_SHA', 'customizationSHA'), ('MODELS_SHA', 'modelsSHA')]:
                if os.environ.get(env_key) and fixture_inputs[receipt_key] != os.environ[env_key]:
                    raise ValueError('quota fixture input mismatch: ' + receipt_key)
            receipt['quotaFixture'] = fixture_inputs
            harness('v8-quota-http-candidate', fixture)
            harness('pro-route-contract-candidate', candidate,
                    ['--management', frontend, '--bun', os.environ.get('BUN', 'bun')])
        published_tag = os.environ.get('CORE_PUBLISHED_TAG', '')
        if published_tag:
            binary = download(os.environ['CURRENT_REPO'], published_tag, root / 'published-core', args.platform)
            published_hash = sha256(binary)
            duplicate = candidate is not None and published_hash == sha256(candidate)
            receipt['productBinaries'].append({'role': 'published', 'tag': published_tag,
                                              'binarySha256': published_hash, 'deduplicated': duplicate})
            if not duplicate:
                # Both modes reuse the already tested/built generated frontend.
                run('pro-route-contract-published', [sys.executable, scripts / 'e2e/pro-route-contract/run.py',
                    '--binary', binary, '--management', frontend, '--bun', os.environ.get('BUN', 'bun'),
                    '--output', root / 'pro-route-contract-published'])
        elif candidate is None:
            raise ValueError('Management-only gate requires the frozen published Core tag')
        receipt['passed'] = True
    except Exception:
        receipt['error'] = traceback.format_exc()
        raise
    finally:
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(root / 'receipt.json')


if __name__ == '__main__':
    main()

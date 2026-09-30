"""Contracts recorded before release gate implementation; real HTTP E2E is separate."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReleaseHTTPGateContracts(unittest.TestCase):
    def test_release_wiring_preserves_actual_inputs_and_failure_artifacts(self):
        core = (ROOT / '.github/workflows/release-core.yml').read_text()
        management = (ROOT / '.github/workflows/release-management.yml').read_text()
        core_management = core.split('  validate-management:', 1)[1].split('  build-image-platform:', 1)[0]
        self.assertIn('- validate-core', core_management)
        self.assertIn('- build-core-linux', core_management)
        self.assertIn('VALIDATION_RELEASE_HTTP_GATES: "1"', core)
        self.assertIn('current_release_tag:', core)
        self.assertIn('CORE_CANDIDATE_ARCHIVE:', core_management)
        self.assertIn('CORE_QUOTA_FIXTURE:', core_management)
        self.assertIn('CORE_PUBLISHED_TAG:', core_management)
        self.assertIn('release_http_gates.py', core_management)
        self.assertIn('if: always()', core_management)
        section = management.split('  validate-management:', 1)[1].split('  publish-management-asset:', 1)[0]
        self.assertIn('CORE_PUBLISHED_TAG: ${{ needs.check-version.outputs.target_release_tag }}', section)
        self.assertIn('release_http_gates.py', section)
        self.assertIn('if: always()', section)
        self.assertLess(section.index('release_http_gates.py'), section.index('Upload validated management asset'))
        for text in (core, management):
            self.assertNotIn('--json tagName --jq \'.tagName\' 2>/dev/null || true', text)

    def test_opt_in_quota_fixture_is_retained_separately(self):
        text = (ROOT / 'scripts/validation/core.sh').read_text()
        self.assertIn('VALIDATION_RELEASE_HTTP_GATES', text)
        self.assertIn('${validation_tmp}/quota-http-fixture', text)
        self.assertIn('quota-fixture-inputs.json', text)


class PublishedCoreDownloadContracts(unittest.TestCase):
    def run_download(self, mode='valid'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets = root / 'assets'
            assets.mkdir()
            archive = assets / 'CLIProxyAPI_8.0.0-pro_linux_amd64.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                content = b'#!/bin/sh\nexit 0\n'
                info = tarfile.TarInfo('cli-proxy-api')
                info.mode = 0o755
                if mode == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/bin/sh'
                    tar.addfile(info)
                else:
                    info.size = len(content)
                    tar.addfile(info, io.BytesIO(content))
                    if mode == 'duplicate_binary':
                        tar.addfile(info, io.BytesIO(content))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            checksum = '0' * 64 if mode == 'bad_checksum' else digest
            (assets / 'checksums.txt').write_text(checksum + '  ' + archive.name + '\n')
            if mode == 'missing_checksum':
                (assets / 'checksums.txt').write_text('')
            if mode == 'duplicate_checksum':
                (assets / 'checksums.txt').write_text((checksum + '  ' + archive.name + '\n') * 2)
            metadata = {'id': 123, 'tag_name': 'v8.0.0-pro', 'draft': False,
                        'assets': [{'id': 456, 'name': archive.name,
                                    'digest': 'sha256:' + ('1' * 64 if mode == 'bad_digest' else digest)}]}
            if mode == 'wrong_tag':
                metadata['tag_name'] = 'v8.1.0-pro'
            gh = root / 'gh'
            gh.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, shutil, sys
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as stream: stream.write(json.dumps(args) + '\\n')
if os.environ['MODE'] == 'network': sys.exit(17)
if args[0] == 'api': print(os.environ['METADATA'])
else:
    destination = pathlib.Path(args[args.index('--dir') + 1])
    for source in pathlib.Path(os.environ['ASSETS']).iterdir(): shutil.copy2(source, destination / source.name)
''')
            gh.chmod(0o755)
            output = root / 'result'
            environment = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                               MODE=mode, METADATA=json.dumps(metadata), ASSETS=str(assets), CALLS=str(root / 'calls'))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/validation/download_published_core.py'),
                                     '--repo', 'owner/repo', '--tag', 'v8.0.0-pro', '--output', str(output)],
                                    env=environment, capture_output=True, text=True)
            receipt_path = output / 'receipt.json'
            receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
            calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
            return result, receipt, calls, (output / 'cli-proxy-api').exists()

    def test_exact_release_download_and_verified_binary(self):
        result, receipt, calls, binary = self.run_download()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(binary)
        self.assertTrue(receipt['passed'])
        self.assertEqual(receipt['tag'], 'v8.0.0-pro')
        self.assertIn('repos/owner/repo/releases/tags/v8.0.0-pro', calls)
        self.assertIn('v8.0.0-pro', calls)

    def test_failures_never_execute_or_hide_download_receipt(self):
        for mode in ('bad_checksum', 'bad_digest', 'missing_checksum', 'duplicate_checksum',
                     'symlink', 'duplicate_binary', 'wrong_tag', 'network'):
            with self.subTest(mode=mode):
                result, receipt, _, binary = self.run_download(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNotNone(receipt, result.stderr)
                self.assertFalse(receipt['passed'])
                self.assertFalse(binary)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Download and verify the actual executable from one frozen Pro release tag."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import traceback


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def extract_binary(archive, destination):
    # Extract only the expected regular executable, never a release-supplied path.
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('unsafe archive member: ' + member.name)
        matches = [member for member in members if member.name in ('cli-proxy-api', './cli-proxy-api')]
        if len(matches) != 1 or not matches[0].isfile():
            raise ValueError('archive must contain one regular cli-proxy-api executable')
        with tar.extractfile(matches[0]) as source, destination.open('xb') as target:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                target.write(block)
    destination.chmod(0o755)


def download(repo, tag, output, platform='linux_amd64'):
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'passed': False, 'repository': repo, 'tag': tag, 'platform': platform}
    try:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('invalid repository')
        if not re.fullmatch(r'v?[0-9][A-Za-z0-9_.-]*-pro', tag):
            raise ValueError('invalid Pro release tag')
        metadata = json.loads(subprocess.check_output(
            ['gh', 'api', f'repos/{repo}/releases/tags/{tag}'], text=True))
        (output / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
        if metadata['tag_name'] != tag or metadata.get('draft'):
            raise ValueError('release metadata does not identify the published target tag')
        name = f'CLIProxyAPI_{tag.removeprefix("v")}_{platform}.tar.gz'
        assets = [asset for asset in metadata['assets'] if asset['name'] == name]
        if len(assets) != 1:
            raise ValueError('release must contain one exact Core archive: ' + name)
        asset = assets[0]
        receipt.update(releaseID=metadata['id'], assetID=asset['id'], archive=name,
                       publishedAt=metadata.get('published_at'), githubDigest=asset.get('digest'))
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--pattern', name,
                        '--pattern', 'checksums.txt', '--dir', str(output)], check=True)
        archive = output / name
        actual = sha256(archive)
        matches = []
        for line in (output / 'checksums.txt').read_text().splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[1].lstrip('*') == name:
                matches.append(fields[0])
        if len(matches) != 1 or matches[0] != actual:
            raise ValueError('Core archive checksum is missing, duplicated or mismatched')
        github_digest = asset.get('digest')
        if github_digest and github_digest != 'sha256:' + actual:
            raise ValueError('Core archive GitHub asset digest mismatch')
        receipt['archiveSha256'] = actual
        binary = output / 'cli-proxy-api'
        extract_binary(archive, binary)
        receipt.update(binarySha256=sha256(binary), passed=True)
        return binary
    except Exception:
        receipt['error'] = traceback.format_exc()
        raise
    finally:
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--platform', default='linux_amd64', choices=['linux_amd64', 'darwin_aarch64', 'darwin_amd64'])
    args = parser.parse_args()
    print(download(args.repo, args.tag, args.output.resolve(), args.platform))


if __name__ == '__main__':
    main()

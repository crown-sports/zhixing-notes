"""Package only the curated vault and built first-party plugins. No vault export."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ('review-workbench', 'pdf-location-bookmarks')
CORE_CONFIG = {'app.json', 'appearance.json', 'core-plugins.json', 'community-plugins.json',
               'templates.json', 'daily-notes.json', 'hotkeys.json'}
PLUGIN_FILES = ('main.js', 'manifest.json', 'styles.css')


def vault_files(vault):
    """Fail on unexpected config/binaries instead of silently shipping them."""
    selected = []
    for path in sorted(vault.rglob('*')):
        if path.is_symlink():
            raise ValueError('Release inputs cannot be symbolic links: ' + path.name)
        if not path.is_file():
            continue
        rel = path.relative_to(vault).as_posix()
        if rel.startswith('.obsidian/'):
            allowed = rel in {'.obsidian/' + p for p in CORE_CONFIG} or rel == '.obsidian/snippets/zhixing.css'
        else:
            allowed = not any(p.startswith('.') for p in Path(rel).parts) and path.suffix == '.md'
        if not allowed:
            raise ValueError('Unexpected release input: ' + rel)
        selected.append((path, rel))
    if not (vault / '00_开始.md').is_file():
        raise ValueError('Starter homepage is missing')
    return selected


def check_vault(vault):
    selected = vault_files(vault)
    existing = {rel for _, rel in selected}
    for path, rel in selected:
        text = path.read_text(encoding='utf-8')
        if path.suffix == '.json':
            json.loads(text)
        if path.suffix != '.md':
            continue
        for target in re.findall(r'!?\[\[([^\]]+)\]\]', text):
            # Markdown tables escape the alias separator before Obsidian resolves it.
            target = target.replace(r'\|', '|').split('|', 1)[0].split('#', 1)[0]
            if not target or '{{' in target:
                continue
            candidates = {target, target + '.md', (Path(rel).parent / (target + '.md')).as_posix()}
            if not candidates & existing:
                raise ValueError('Broken starter link in ' + rel + ': ' + target)
    configs = vault / '.obsidian'
    daily = json.loads((configs / 'daily-notes.json').read_text(encoding='utf-8'))
    templates = json.loads((configs / 'templates.json').read_text(encoding='utf-8'))
    for folder in (daily['folder'], templates['folder']):
        if not (vault / folder).is_dir():
            raise ValueError('Configured folder missing: ' + folder)
    if daily['template'] + '.md' not in existing:
        raise ValueError('Daily template missing')
    if json.loads((configs / 'community-plugins.json').read_text(encoding='utf-8')) != []:
        raise ValueError('Starter plugins must remain opt-in')
    return selected


def write_zip(destination, entries):
    # Stable metadata makes rebuilding the same sources byte-for-byte repeatable.
    names = set()
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in sorted(entries, key=lambda item: item[1]):
            name = name.replace('\\', '/')
            if name in names or name.startswith('/') or '..' in name.split('/'):
                raise ValueError('Unsafe or duplicate archive member')
            if source.is_symlink() or not source.is_file():
                raise ValueError('Missing or unsafe artifact: ' + source.name)
            names.add(name)
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes())


def package(root=ROOT):
    selected = check_vault(root / 'vault')
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    entries = [(p, 'Zhixing-Notes/' + rel) for p, rel in selected]
    out = root / 'dist'
    out.mkdir(exist_ok=True)
    archives = []
    for plugin in PLUGINS:
        directory = root / 'plugins' / plugin
        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
        if manifest['id'] != plugin or manifest['version'] != version:
            raise ValueError('Plugin identity/version differs from release: ' + plugin)
        if not manifest['isDesktopOnly']:
            raise ValueError('Optional plugins have only been scoped for desktop')
        payload = [(directory / name, plugin + '/' + name) for name in PLUGIN_FILES]
        for path, name in payload:
            entries.append((path, 'Zhixing-Notes/.obsidian/plugins/' + name))
        payload += [(root / 'LICENSE', plugin + '/LICENSE'), (directory / 'README.md', plugin + '/README.md')]
        destination = out / (plugin + '.zip')
        write_zip(destination, payload)
        archives.append(destination)
    entries += [(root / 'LICENSE', 'Zhixing-Notes/LICENSE'), (root / 'NOTICE', 'Zhixing-Notes/NOTICE')]
    destination = out / 'Zhixing-Notes.zip'
    write_zip(destination, entries)
    archives.append(destination)
    sums = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in sorted(archives))
    (out / 'SHA256SUMS.txt').write_text(sums, encoding='utf-8')
    return archives


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        print('Checked', len(check_vault(ROOT / 'vault')), 'curated files and their internal links.')
    else:
        for artifact in package():
            print(artifact.name, artifact.stat().st_size, 'bytes')

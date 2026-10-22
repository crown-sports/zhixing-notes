import importlib.util
from pathlib import Path
import re
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_tool', ROOT / 'tools/package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ReleaseTests(unittest.TestCase):
    def test_starter_links_and_core_configuration_are_self_contained(self):
        self.assertGreater(len(package.check_vault(ROOT / 'vault')), 10)

    def test_personal_workspace_or_unknown_plugin_state_cannot_be_bundled(self):
        with tempfile.TemporaryDirectory() as temp:
            vault = Path(temp) / 'vault'
            shutil.copytree(ROOT / 'vault', vault)
            (vault / '.obsidian/workspace.json').write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Unexpected release input'):
                package.check_vault(vault)

    def test_same_sources_produce_same_zip_without_local_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            first, second = Path(temp) / 'first.zip', Path(temp) / 'second.zip'
            entries = [(ROOT / 'vault/00_开始.md', 'Zhixing-Notes/00_开始.md')]
            package.write_zip(first, entries)
            package.write_zip(second, entries)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), ['Zhixing-Notes/00_开始.md'])

    def test_broken_internal_link_prevents_a_release(self):
        with tempfile.TemporaryDirectory() as temp:
            vault = Path(temp) / 'vault'
            shutil.copytree(ROOT / 'vault', vault)
            with (vault / '00_开始.md').open('a', encoding='utf-8') as stream:
                stream.write('\n[[missing-note]]\n')
            with self.assertRaisesRegex(ValueError, 'Broken starter link'):
                package.check_vault(vault)

    def test_starter_table_links_do_not_split_aliases_into_columns(self):
        for path in (ROOT / 'vault').rglob('*.md'):
            for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                if not line.lstrip().startswith('|'):
                    continue
                for link in re.findall(r'!?\[\[([^\]]+)\]\]', line):
                    with self.subTest(path=path.name, line=number):
                        self.assertIsNone(re.search(r'(?<!\\)\|', link))

    def test_escaped_table_aliases_still_validate_the_link_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            vault = Path(temp) / 'vault'
            shutil.copytree(ROOT / 'vault', vault)
            table = vault / 'table.md'
            table.write_text('| Entry |\n| --- |\n| [[使用说明\\|Read the guide]] |\n', encoding='utf-8')
            package.check_vault(vault)
            table.write_text('| Entry |\n| --- |\n| [[missing-note\\|Read the guide]] |\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Broken starter link in table.md: missing-note'):
                package.check_vault(vault)

    def test_archive_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                package.write_zip(Path(temp) / 'bad.zip', [(ROOT / 'vault/00_开始.md', '../escape.md')])


if __name__ == '__main__':
    unittest.main()

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../src/', import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.name !== 'generated').map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : Promise.resolve(path.endsWith('.ts') ? [path] : []);
  }));
  return files.flat();
}

async function imports(path: string): Promise<string[]> {
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
  });
}

describe('architecture boundaries', () => {
  it('keeps domain entities, use cases and contracts independent of frameworks and persistence', async () => {
    const domain = join(root, 'domain');
    for (const file of await sources(domain)) {
      for (const dependency of await imports(file)) {
        expect(dependency.startsWith('.'), `${file}: ${dependency}`).toBe(true);
        expect(resolve(dirname(file), dependency).startsWith(`${domain}${sep}`), `${file}: ${dependency}`).toBe(true);
      }
    }
  });

  it('keeps HTTP presentation independent of concrete infrastructure', async () => {
    for (const file of await sources(join(root, 'presentation'))) {
      for (const dependency of await imports(file)) {
        expect(dependency, file).not.toMatch(/infrastructure|generated|\/main\.js|\/server\.js/);
      }
    }
  });

  it('has no source dependency cycles', async () => {
    const files = await sources(root);
    const graph = new Map<string, string[]>();
    for (const file of files) graph.set(file, (await imports(file)).filter((item) => item.startsWith('.'))
      .map((item) => resolve(dirname(file), item).replace(/\.js$/, '.ts')));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function visit(file: string): void {
      if (!graph.has(file) || visited.has(file)) return;
      expect(visiting.has(file), `Ciclo de dependencias: ${[...visiting, file].join(' -> ')}`).toBe(false);
      visiting.add(file);
      for (const dependency of graph.get(file)!) visit(dependency);
      visiting.delete(file);
      visited.add(file);
    }
    for (const file of files) visit(file);
  });
});

'use strict';

/**
 * Exportação de contexto para LLMs, com os delimitadores definidos no PRD.
 */

const RULE = '='.repeat(80);

const CATEGORIES = [
  { id: 'main', key: 'MAIN_PROGRAM', suffix: 'main', label: 'Programa principal' },
  { id: 'programs', key: 'PROGRAMS', suffix: 'programas', label: 'Programas' },
  { id: 'forms', key: 'FORMS', suffix: 'formularios', label: 'Formulários' },
  { id: 'classes', key: 'CLASSES', suffix: 'classes', label: 'Classes' },
  { id: 'reports', key: 'REPORTS', suffix: 'relatorios', label: 'Relatórios' },
  { id: 'menus', key: 'MENUS', suffix: 'menus', label: 'Menus' },
  { id: 'others', key: 'OTHERS', suffix: 'outros', label: 'Outros arquivos' },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

function today() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function stemOf(name) {
  return String(name || 'projeto')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim() || 'projeto';
}

function typeOf(file) {
  return String(file.type || file.ext || 'FILE').toUpperCase();
}

function metadataBlock(workspace, totalFiles) {
  return [
    RULE,
    '[PROJECT_METADATA]',
    `PROJECT_NAME: ${workspace.name || workspace.projectFile || 'projeto'}`,
    `EXPORT_DATE: ${today()}`,
    `TOTAL_FILES: ${totalFiles}`,
    RULE,
  ].join('\n');
}

function fileBlock(file) {
  const path = String(file.path || file.name || 'arquivo');
  const content = String(file.content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '');
  return [
    `--- BEGIN_FILE: ${path} | TYPE: ${typeOf(file)} ---`,
    content,
    `--- END_FILE: ${path} ---`,
  ].join('\n');
}

function categoryBlock(category, files) {
  const parts = [
    RULE,
    `<<< START_CATEGORY: ${category.key} >>>`,
    RULE,
    '',
  ];
  for (const file of files) {
    parts.push(fileBlock(file), '');
  }
  parts.push(RULE, `<<< END_CATEGORY: ${category.key} >>>`, RULE);
  return parts.join('\n');
}

function groupFiles(files) {
  const groups = new Map(CATEGORIES.map((category) => [category.id, []]));
  for (const file of files) {
    const id = CATEGORY_BY_ID.has(file.category) ? file.category : 'others';
    groups.get(id).push(file);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.path).localeCompare(String(b.path), 'pt-BR', { sensitivity: 'base' }));
  }
  return groups;
}

/**
 * @param {{name: string}} workspace
 * @param {Array<{path: string, category: string, type: string, content: string}>} files
 * @returns {{name: string, content: string}}
 */
export function buildUnifiedExport(workspace, files) {
  const groups = groupFiles(files);
  const blocks = [metadataBlock(workspace, files.length)];
  for (const category of CATEGORIES) {
    const list = groups.get(category.id);
    if (!list || list.length === 0) continue;
    blocks.push('', categoryBlock(category, list));
  }
  return {
    name: `${stemOf(workspace.name)}_llm.txt`,
    content: `${blocks.join('\n')}\n`,
  };
}

/**
 * Um arquivo .txt por categoria (somente categorias com arquivos).
 * @returns {Array<{name: string, content: string, category: string}>}
 */
export function buildPartitionedExport(workspace, files) {
  const groups = groupFiles(files);
  const output = [];
  for (const category of CATEGORIES) {
    const list = groups.get(category.id);
    if (!list || list.length === 0) continue;
    const content = [
      metadataBlock(workspace, list.length),
      '',
      categoryBlock(category, list),
      '',
    ].join('\n');
    output.push({
      category: category.id,
      name: `${stemOf(workspace.name)}_${category.suffix}.txt`,
      content,
    });
  }
  return output;
}

export const EXPORT_CATEGORIES = CATEGORIES;
export const EXPORT_RULE = RULE;

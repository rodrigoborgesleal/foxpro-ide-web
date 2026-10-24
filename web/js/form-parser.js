'use strict';

/**
 * Parser mínimo e intencionalmente conservador para o texto gerado pelo
 * FoxBin2Prg (.sc2/.vc2). Ele não executa nada do formulário: apenas lê
 * DEFINE CLASS, blocos PropValue, ADD OBJECT e propriedades.
 */

export const STANDARD_BASE_CLASSES = new Set([
  'form',
  'formset',
  'toolbar',
  'container',
  'pageframe',
  'page',
  'grid',
  'column',
  'header',
  'commandbutton',
  'commandgroup',
  'optionbutton',
  'optiongroup',
  'textbox',
  'editbox',
  'checkbox',
  'combobox',
  'listbox',
  'spinner',
  'label',
  'shape',
  'line',
  'image',
  'timer',
  'olecontrol',
  'oleboundcontrol',
  'hyperlink',
  'separator',
  'dataenvironment',
  'cursor',
  'relation',
  'cursoradapter',
  'session',
  'custom',
  'collection',
  'exception',
  'xmladapter',
  'xmlfield',
  'richtext',
  'control',
]);

export const FORM_BASE_CLASSES = new Set(['form', 'formset', 'toolbar']);

const NON_VISUAL_BASES = new Set([
  'timer',
  'dataenvironment',
  'cursor',
  'relation',
  'cursoradapter',
  'session',
  'collection',
  'exception',
  'xmladapter',
  'xmlfield',
]);

const DEFAULT_GEOMETRY = {
  form: { width: 420, height: 260 },
  formset: { width: 420, height: 260 },
  toolbar: { width: 420, height: 28 },
  container: { width: 100, height: 100 },
  pageframe: { width: 300, height: 200 },
  page: { width: 300, height: 180 },
  grid: { width: 240, height: 150 },
  column: { width: 80, height: 20 },
  header: { width: 80, height: 20 },
  commandbutton: { width: 100, height: 27 },
  commandgroup: { width: 100, height: 27 },
  optionbutton: { width: 100, height: 18 },
  optiongroup: { width: 120, height: 60 },
  textbox: { width: 100, height: 23 },
  editbox: { width: 150, height: 60 },
  checkbox: { width: 100, height: 18 },
  combobox: { width: 120, height: 23 },
  listbox: { width: 120, height: 80 },
  spinner: { width: 100, height: 23 },
  label: { width: 80, height: 18 },
  shape: { width: 100, height: 100 },
  line: { width: 100, height: 1 },
  image: { width: 100, height: 100 },
  olecontrol: { width: 120, height: 100 },
  oleboundcontrol: { width: 120, height: 100 },
  hyperlink: { width: 100, height: 18 },
  separator: { width: 100, height: 1 },
  custom: { width: 120, height: 60 },
};

function lower(value) {
  return String(value ?? '').toLowerCase();
}

function toNumber(value, fallback = NaN) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return fallback;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

export function getDefaultGeometry(baseClass) {
  const base = lower(baseClass);
  return DEFAULT_GEOMETRY[base] || DEFAULT_GEOMETRY.custom;
}

export function isNonVisualBase(baseClass) {
  return NON_VISUAL_BASES.has(lower(baseClass));
}

function parseValue(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';

  const lowerValue = value.toLowerCase();
  if (lowerValue === '.t.') return true;
  if (lowerValue === '.f.') return false;
  if (lowerValue === '.null.') return null;

  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);

  if (/^"(?:[^"]|"")*"$/.test(value)) {
    return value.slice(1, -1).replace(/""/g, '"');
  }

  if (/^'(?:[^']|'')*'$/.test(value)) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  // Cores em formato "r,g,b" e expressões como RGB(...) ficam como texto;
  // o renderer faz a conversão para CSS.
  return value;
}

function parsePropertyLine(line) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) return null;

  let raw = match[2].trim();
  if (raw.endsWith(';')) raw = raw.slice(0, -1).trimEnd();
  if (raw.endsWith(',')) raw = raw.slice(0, -1).trimEnd();

  return {
    name: match[1],
    raw,
    value: parseValue(raw),
  };
}

function lastPathPart(path) {
  const parts = String(path ?? '').split('.');
  return parts[parts.length - 1] || String(path ?? '');
}

/**
 * PageFrames e grids do VFP podem declarar os filhos "virtuais" como
 * propriedades: Page1.Name, Page1.Caption, Column1.Width etc. Nesse caso não
 * existe um ADD OBJECT próprio para a página/coluna. Criamos esses nós para
 * que o renderer consiga montar as abas e as colunas do grid.
 */
function expandImplicitObjects(objects) {
  const list = Array.isArray(objects) ? objects : [];
  const byPath = new Map(list.map((object) => [lower(object.path), object]));
  const additions = [];

  for (const object of list) {
    const base = lower(object.baseClass);
    if (base !== 'pageframe' && base !== 'grid') continue;

    const groups = new Map();
    const prefixPattern = base === 'pageframe' ? /^Page(\d+)\.([A-Za-z0-9_]+)$/i : /^Column(\d+)\.([A-Za-z0-9_]+)$/i;
    for (const [propertyName, value] of Object.entries(object.properties || {})) {
      const match = prefixPattern.exec(propertyName);
      if (!match) continue;
      const key = match[1];
      if (!groups.has(key)) groups.set(key, {});
      groups.get(key)[match[2]] = value;
    }

    const orderedGroups = Array.from(groups.entries()).sort((left, right) => {
      const leftOrder = Number(left[1].PageOrder);
      const rightOrder = Number(right[1].PageOrder);
      const leftKey = Number.isFinite(leftOrder) ? leftOrder : Number(left[0]);
      const rightKey = Number.isFinite(rightOrder) ? rightOrder : Number(right[0]);
      return leftKey - rightKey;
    });

    for (const [key, group] of orderedGroups) {
      const index = key;
      const defaultName = base === 'pageframe' ? `Page${index}` : `Column${index}`;
      const name = String(group.Name || defaultName);
      const path = `${object.path}.${name}`;
      const existing = byPath.get(lower(path));

      if (existing) {
        // ADD OBJECT explícito tem prioridade sobre as propriedades PageN.* /
        // ColumnN.*. Ainda assim, preservamos as propriedades sintetizadas que
        // não foram declaradas explicitamente.
        existing.properties = {
          ...group,
          Name: name,
          ...(existing.properties || {}),
        };
        continue;
      }

      const synthetic = {
        path,
        name,
        baseClass: base === 'pageframe' ? 'page' : 'column',
        properties: { ...group, Name: name },
        propertySources: {},
        children: [],
        line: object.line,
        synthetic: true,
      };
      additions.push(synthetic);
      byPath.set(lower(path), synthetic);
    }
  }

  return additions.length ? list.concat(additions) : list;
}

/**
 * @param {string} source
 * @returns {{
 *   classes: Array<{
 *     name: string,
 *     baseClass: string,
 *     properties: Record<string, unknown>,
 *     propertySources: Record<string, {raw: string, line: number}>,
 *     objects: Array<any>,
 *     methods: Array<{name: string, line: number}>,
 *     line: number,
 *     endLine: number
 *   }>,
 *   warnings: string[]
 * }}
 */
export function parseSc2(source) {
  const text = String(source ?? '');
  const lines = text.split(/\r\n|\n|\r/);
  const classes = [];
  const warnings = [];

  let currentClass = null;
  let currentObject = null;
  let inPropValue = false;
  let inMethod = false;

  function startClass(name, baseClass, line) {
    currentClass = {
      name,
      baseClass,
      properties: {},
      propertySources: {},
      objects: [],
      methods: [],
      line,
      endLine: line,
    };
    currentObject = null;
    inPropValue = false;
    inMethod = false;
  }

  function finishClass(line) {
    if (!currentClass) return;
    currentClass.endLine = line;
    classes.push(currentClass);
    currentClass = null;
    currentObject = null;
    inPropValue = false;
    inMethod = false;
  }

  function finishObject() {
    currentObject = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNumber = index + 1;

    if (inMethod) {
      if (/^END(PROC|FUNC)\b/i.test(trimmed)) {
        inMethod = false;
        continue;
      }
      if (/^ENDDEFINE\b/i.test(trimmed)) {
        inMethod = false;
      } else {
        continue;
      }
    }

    if (!trimmed) continue;

    if (/^DEFINE\s+CLASS\b/i.test(trimmed)) {
      if (currentClass) finishClass(lineNumber - 1);
      const match = /^DEFINE\s+CLASS\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        trimmed,
      );
      if (!match) {
        warnings.push(`Linha ${lineNumber}: DEFINE CLASS não reconhecido.`);
        continue;
      }
      startClass(match[1], match[2], lineNumber);
      continue;
    }

    if (/^ENDDEFINE\b/i.test(trimmed)) {
      finishClass(lineNumber);
      continue;
    }

    if (!currentClass) continue;

    if (/^\*\s*<PropValue>/i.test(trimmed)) {
      inPropValue = true;
      currentObject = null;
      continue;
    }

    if (/^\*\s*<\/PropValue>/i.test(trimmed)) {
      inPropValue = false;
      continue;
    }

    if (/^\*\s*<END\s+OBJECT/i.test(trimmed)) {
      finishObject();
      continue;
    }

    if (/^ADD\s+OBJECT\b/i.test(trimmed)) {
      finishObject();
      inPropValue = false;

      const match = /^ADD\s+OBJECT\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        trimmed,
      );
      if (!match) {
        warnings.push(`Linha ${lineNumber}: ADD OBJECT não reconhecido.`);
        continue;
      }

      const path = String(match[1] || match[2] || match[3] || '').trim();
      if (!path) continue;

      currentObject = {
        path,
        name: lastPathPart(path),
        baseClass: match[4],
        properties: {},
        propertySources: {},
        children: [],
        line: lineNumber,
      };
      currentClass.objects.push(currentObject);
      continue;
    }

    if (/^(PROCEDURE|FUNCTION)\b/i.test(trimmed)) {
      finishObject();
      inPropValue = false;
      const method = /^(?:PROCEDURE|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(trimmed);
      currentClass.methods.push({
        name: method ? method[1] : '',
        line: lineNumber,
      });
      inMethod = true;
      continue;
    }

    if (trimmed.startsWith('*')) continue;

    if (inPropValue && currentClass && !currentObject) {
      const property = parsePropertyLine(line);
      if (property) {
        currentClass.properties[property.name] = property.value;
        currentClass.propertySources[property.name] = {
          raw: property.raw,
          line: lineNumber,
        };
      }
      continue;
    }

    if (currentObject) {
      const property = parsePropertyLine(line);
      if (property) {
        currentObject.properties[property.name] = property.value;
        currentObject.propertySources[property.name] = {
          raw: property.raw,
          line: lineNumber,
        };
      }
    }
  }

  if (currentClass) finishClass(lines.length);
  if (!classes.length) warnings.push('Nenhum bloco DEFINE CLASS foi encontrado.');

  for (const classDef of classes) {
    classDef.objects = expandImplicitObjects(classDef.objects);
  }

  return { classes, warnings };
}

function mergeObjectDefinitions(baseObjects, ownObjects) {
  const result = [];
  const indexes = new Map();

  for (const object of [...(baseObjects || []), ...(ownObjects || [])]) {
    const key = lower(object.path || object.name);
    if (indexes.has(key)) {
      result[indexes.get(key)] = object;
    } else {
      indexes.set(key, result.length);
      result.push(object);
    }
  }

  return result;
}

/**
 * Converte a lista plana de ADD OBJECT em uma árvore baseada nos caminhos
 * pontuados (pgfPeople.pagCustomers.Label6). Os objetos são clonados para
 * que a árvore de uma instância não altere o registro de classes.
 */
export function buildObjectTree(objects) {
  const nodes = (objects || []).map((object) => ({
    ...object,
    properties: { ...(object.properties || {}) },
    propertySources: { ...(object.propertySources || {}) },
    children: [],
    parent: null,
  }));

  const byPath = new Map();
  for (const node of nodes) {
    byPath.set(lower(node.path), node);
  }

  const roots = [];
  for (const node of nodes) {
    const segments = String(node.path || '').split('.');
    let parent = null;

    for (let count = segments.length - 1; count >= 1; count -= 1) {
      const candidate = byPath.get(lower(segments.slice(0, count).join('.')));
      if (candidate && candidate !== node) {
        parent = candidate;
        break;
      }
    }

    node.parent = parent;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/**
 * Constrói um registro de classes customizadas a partir dos .vc2 do
 * workspace. As classes do .sc2 ativo são adicionadas depois, com prioridade.
 */
export function buildClassRegistry(files) {
  const registry = new Map();
  const warnings = [];

  for (const file of files || []) {
    const filePath = String(file.path || '');
    if (!/\.vc2$/i.test(filePath)) continue;

    let parsed;
    try {
      parsed = parseSc2(file.content);
    } catch (error) {
      warnings.push(`Não foi possível ler ${filePath}: ${error.message || error}`);
      continue;
    }

    warnings.push(...parsed.warnings.map((warning) => `${filePath}: ${warning}`));

    for (const classDef of parsed.classes) {
      const key = lower(classDef.name);
      if (!key) continue;
      if (!registry.has(key)) {
        registry.set(key, {
          ...classDef,
          sourcePath: filePath,
        });
      }
    }
  }

  return { registry, warnings };
}

/**
 * Mescla a definição da classe com suas classes-base, resolvendo a classe
 * padrão final (form, container, commandbutton, etc.).
 */
export function resolveClassChain(name, registry, seen = new Set()) {
  const key = lower(name);

  if (!key) {
    return {
      standardBase: 'custom',
      isStandard: false,
      isCustom: false,
      resolved: false,
      cycle: false,
      properties: {},
      objects: [],
      chain: [],
    };
  }

  if (STANDARD_BASE_CLASSES.has(key)) {
    return {
      standardBase: key,
      isStandard: true,
      isCustom: false,
      resolved: true,
      cycle: false,
      properties: {},
      objects: [],
      chain: [key],
    };
  }

  if (seen.has(key)) {
    return {
      standardBase: 'custom',
      isStandard: false,
      isCustom: true,
      resolved: false,
      cycle: true,
      properties: {},
      objects: [],
      chain: [name],
    };
  }

  const classDef = registry.get(key);
  if (!classDef) {
    return {
      standardBase: name,
      isStandard: false,
      isCustom: false,
      resolved: false,
      cycle: false,
      properties: {},
      objects: [],
      chain: [name],
    };
  }

  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const base = resolveClassChain(classDef.baseClass, registry, nextSeen);

  return {
    standardBase: base.standardBase,
    isStandard: base.isStandard,
    isCustom: true,
    resolved: base.resolved,
    cycle: base.cycle,
    properties: {
      ...base.properties,
      ...(classDef.properties || {}),
    },
    objects: mergeObjectDefinitions(base.objects, classDef.objects),
    chain: [classDef.name, ...base.chain],
    sourcePath: classDef.sourcePath || '',
  };
}

function instantiateNode(objectDef, parentPath, registry, stack, depth, warnings) {
  const baseClass = objectDef.baseClass || 'custom';
  const resolved = resolveClassChain(baseClass, registry);
  const name = objectDef.name || lastPathPart(objectDef.path);
  const path = parentPath ? `${parentPath}.${name}` : name;
  const properties = {
    ...resolved.properties,
    ...(objectDef.properties || {}),
    Name: name,
  };

  const standardBase = lower(resolved.standardBase);
  const classCycle = resolved.cycle || stack.includes(lower(baseClass));
  const canExpandClass = !classCycle && depth < 8 && resolved.objects.length > 0;

  if (!resolved.resolved) {
    warnings.push(
      resolved.isCustom
        ? `A classe "${baseClass}" não pôde ser resolvida completamente.`
        : `A classe "${baseClass}" não é uma classe base conhecida.`,
    );
  } else if (classCycle) {
    warnings.push(`Herança circular detectada em "${baseClass}".`);
  }

  const classChildren = canExpandClass ? buildObjectTree(resolved.objects) : [];
  const explicitChildren = objectDef.children || [];
  const childrenByName = new Map();

  for (const child of classChildren) {
    childrenByName.set(lower(child.name || lastPathPart(child.path)), child);
  }
  // Objetos adicionados diretamente no formulário têm prioridade sobre os
  // objetos herdados da classe customizada.
  for (const child of explicitChildren) {
    childrenByName.set(lower(child.name || lastPathPart(child.path)), child);
  }

  const nextStack = [...stack, lower(baseClass)];
  const children = Array.from(childrenByName.values()).map((child) =>
    instantiateNode(child, path, registry, nextStack, depth + 1, warnings),
  );

  return {
    name,
    path,
    baseClass,
    standardBase,
    isCustom: resolved.isCustom,
    isStandard: resolved.isStandard,
    resolved: resolved.resolved,
    classChain: resolved.chain,
    properties,
    children,
  };
}

function uniqueWarnings(warnings) {
  const seen = new Set();
  return (warnings || []).filter((warning) => {
    const key = String(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findRootClass(classes, registry) {
  const candidates = [];

  for (const classDef of classes) {
    const resolved = resolveClassChain(classDef.baseClass, registry);
    const standardBase = lower(resolved.standardBase);
    if (FORM_BASE_CLASSES.has(standardBase)) {
      candidates.push({ classDef, resolved });
    }
  }

  if (candidates.length) return { ...candidates[0], candidates };
  return { classDef: null, resolved: null, candidates: [] };
}

/**
 * Cria o modelo de preview do .sc2 ativo. `files` deve conter os arquivos do
 * workspace (pelo menos os .vc2) para resolver classes customizadas.
 */
export function createPreviewModel(source, files = [], options = {}) {
  const warnings = [];
  const parsed = parseSc2(source);
  warnings.push(...parsed.warnings);

  const registryInfo = buildClassRegistry(files);
  warnings.push(...registryInfo.warnings);
  const registry = registryInfo.registry;

  // Classes definidas no próprio .sc2 ativo têm prioridade. A exceção é
  // "DEFINE CLASS frmsolution AS frmsolution OF arquivo.vcx": o nome da classe
  // coincide com a classe-base e não deve esconder a definição da biblioteca.
  for (const classDef of parsed.classes) {
    const key = lower(classDef.name);
    if (!key) continue;
    const existing = registry.get(key);
    const selfInherits = lower(classDef.baseClass) === key;
    if (!(selfInherits && existing)) {
      registry.set(key, {
        ...classDef,
        sourcePath: options.activePath || '',
      });
    }
  }

  const rootInfo = findRootClass(parsed.classes, registry);
  let rootDef = rootInfo.classDef;
  let rootResolved = null;

  if (!rootDef) {
    rootDef =
      parsed.classes.find((classDef) => {
        const resolved = resolveClassChain(classDef.baseClass, registry);
        return lower(resolved.standardBase) !== 'dataenvironment';
      }) || null;
  }

  if (!rootDef) {
    return {
      ok: false,
      error:
        'Nenhum formulário foi encontrado neste arquivo .sc2. ' +
        'O preview espera um bloco DEFINE CLASS ... AS form.',
      warnings: uniqueWarnings(warnings),
      classes: parsed.classes.map((classDef) => classDef.name),
    };
  }

  rootResolved = resolveClassChain(rootDef.name, registry);
  // No caso de auto-herança (nome da classe igual ao da classe-base), o
  // registro preservou a definição da biblioteca. Aplicamos por cima as
  // propriedades/objetos declarados no .sc2 ativo.
  rootResolved = {
    ...rootResolved,
    properties: {
      ...(rootResolved.properties || {}),
      ...(rootDef.properties || {}),
    },
    objects: mergeObjectDefinitions(rootResolved.objects, rootDef.objects),
  };
  if (!rootResolved.resolved && !FORM_BASE_CLASSES.has(lower(rootResolved.standardBase))) {
    warnings.push(`A classe do formulário "${rootDef.baseClass}" não foi resolvida completamente.`);
  }

  const standardBase = lower(rootResolved.standardBase);
  const scaleMode = rootResolved.properties.ScaleMode;
  const formScale = scaleFactorFor(scaleMode);
  const defaultGeometry = getDefaultGeometry(standardBase);
  const rawWidth = toNumber(rootResolved.properties.Width, defaultGeometry.width);
  const rawHeight = toNumber(rootResolved.properties.Height, defaultGeometry.height);
  const width = Math.max(1, rawWidth * formScale);
  const height = Math.max(1, rawHeight * formScale);

  const tree = buildObjectTree(rootResolved.objects);
  const children = tree.map((child) =>
    instantiateNode(child, '', registry, [lower(rootDef.name)], 0, warnings),
  );

  const formProperties = {
    ...rootResolved.properties,
    Name: rootDef.name,
  };

  return {
    ok: true,
    name: rootDef.name,
    baseClass: rootDef.baseClass,
    standardBase,
    properties: formProperties,
    width,
    height,
    scale: formScale,
    scaleMode,
    children,
    warnings: uniqueWarnings(warnings),
    classes: parsed.classes.map((classDef) => ({
      name: classDef.name,
      baseClass: classDef.baseClass,
    })),
    sourcePath: options.activePath || '',
  };
}

/**
 * Fator de conversão de unidades VFP para pixels CSS. O VFP usa apenas
 * ScaleMode=3 (pixels, padrão) e ScaleMode=0 (foxels). Foxels dependem da
 * fonte do formulário; usamos uma célula aproximada de 8 px.
 */
export function scaleFactorFor(scaleMode) {
  const mode = Number(scaleMode);
  switch (mode) {
    case 0:
      return 8; // foxels (aproximação)
    case 1:
      return 96 / 72; // pontos (compatibilidade)
    case 2:
      return 8; // caracteres (aproximação)
    case 4:
      return 96; // polegadas
    case 5:
      return 96 / 2.54; // centímetros
    case 6:
      return 96 / 25.4; // milímetros
    case 7:
      return 96 / 0.0254; // quilômetros (não usual)
    default:
      return 1; // pixels
  }
}

export function getScaleMode(value) {
  return value === undefined || value === null || value === '' ? 3 : value;
}

export { NON_VISUAL_BASES };

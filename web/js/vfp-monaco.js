'use strict';

/**
 * Integração do Visual FoxPro com o Monaco Editor:
 *  - tokenização (Monarch);
 *  - tema escuro;
 *  - IntelliSense de comandos, funções, classes base e PEMs.
 */

const LANG = globalThis.VFP_LANGUAGE || {
  KEYWORDS: [],
  SQL_KEYWORDS: [],
  COMMANDS: [],
  FUNCTIONS: [],
  CONSTANTS: [],
  SYSTEM_VARS: [],
  COMMON_PEM: { properties: [], events: [], methods: [] },
  BASE_CLASSES: {},
  BASE_CLASS_NAMES: [],
  pemsFor: () => ({ properties: [], events: [], methods: [] }),
  pemsAll: () => ({ properties: [], events: [], methods: [] }),
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueBy(list, key) {
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const value = typeof key === 'function' ? key(item) : item[key];
    const normalized = String(value || '').toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(item);
  }
  return output;
}

const KEYWORDS = uniqueBy(
  [
    ...LANG.KEYWORDS,
    ...LANG.SQL_KEYWORDS,
    ...LANG.COMMANDS.map((command) => command.name),
  ],
  (item) => (typeof item === 'string' ? item : item.name),
).sort((a, b) => b.length - a.length);

const KEYWORD_REGEX = new RegExp(`\\b(?:${KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');

const FUNCTION_BY_NAME = new Map(
  uniqueBy(LANG.FUNCTIONS, (item) => (typeof item === 'string' ? item : item.name)).map((item) => {
    const name = typeof item === 'string' ? item : item.name;
    return [String(name).toLowerCase(), typeof item === 'string' ? { name } : item];
  }),
);

const COMMAND_BY_NAME = new Map(
  uniqueBy(LANG.COMMANDS, (item) => (typeof item === 'string' ? item : item.name)).map((item) => {
    const name = typeof item === 'string' ? item : item.name;
    return [String(name).toLowerCase(), typeof item === 'string' ? { name, sig: '' } : item];
  }),
);

const BASE_CLASS_SET = new Set(
  [...LANG.BASE_CLASS_NAMES, ...Object.keys(LANG.BASE_CLASSES || {})].map((name) =>
    String(name).toLowerCase(),
  ),
);

const SNIPPETS = [
  {
    label: 'IF ... ENDIF',
    insertText: ['IF ${1:condicao}', '\t$0', 'ENDIF'].join('\n'),
    detail: 'Bloco condicional',
  },
  {
    label: 'IF ... ELSE ... ENDIF',
    insertText: ['IF ${1:condicao}', '\t$2', 'ELSE', '\t$0', 'ENDIF'].join('\n'),
    detail: 'Bloco condicional com ELSE',
  },
  {
    label: 'DO CASE ... ENDCASE',
    insertText: [
      'DO CASE',
      '\tCASE ${1:condicao}',
      '\t\t$0',
      'OTHERWISE',
      '\t\t',
      'ENDCASE',
    ].join('\n'),
    detail: 'Seleção múltipla',
  },
  {
    label: 'FOR ... ENDFOR',
    insertText: ['FOR ${1:i} = ${2:1} TO ${3:10}', '\t$0', 'ENDFOR'].join('\n'),
    detail: 'Laço contado',
  },
  {
    label: 'SCAN ... ENDSCAN',
    insertText: ['SCAN', '\t$0', 'ENDSCAN'].join('\n'),
    detail: 'Varredura de tabela',
  },
  {
    label: 'TRY ... CATCH ... ENDTRY',
    insertText: ['TRY', '\t$1', 'CATCH TO ${2:loErro}', '\t$0', 'ENDTRY'].join('\n'),
    detail: 'Tratamento de erros',
  },
  {
    label: 'DEFINE CLASS ... ENDDEFINE',
    insertText: ['DEFINE CLASS ${1:MinhaClasse} AS ${2:Custom}', '\t$0', 'ENDDEFINE'].join('\n'),
    detail: 'Definição de classe',
  },
  {
    label: 'PROCEDURE ... ENDPROC',
    insertText: ['PROCEDURE ${1:NomeProcedimento}', '\t$0', 'ENDPROC'].join('\n'),
    detail: 'Procedimento',
  },
  {
    label: 'FUNCTION ... ENDFUNC',
    insertText: ['FUNCTION ${1:NomeFuncao}(${2:parametros})', '\t$0', 'ENDFUNC'].join('\n'),
    detail: 'Função',
  },
  {
    label: 'WITH ... ENDWITH',
    insertText: ['WITH ${1:objeto}', '\t$0', 'ENDWITH'].join('\n'),
    detail: 'Bloco WITH',
  },
];

const OWNER_ALIASES = new Map([
  ['this', 'form'],
  ['thisform', 'form'],
  ['thisformset', 'formset'],
  ['_screen', 'form'],
  ['_vfp', 'vfp'],
]);

let registered = false;
let editorThemeDefined = false;

export function initVfpLanguage(monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: 'foxpro',
    aliases: ['Visual FoxPro', 'FoxPro', 'vfp'],
    extensions: ['.prg', '.sc2', '.vc2', '.fr2', '.mn2', '.lb2', '.pj2', '.h', '.ini'],
  });

  monaco.languages.setLanguageConfiguration('foxpro', {
    comments: { lineComment: '*' },
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern:
        /^\s*(IF|FOR|DO\s+CASE|CASE|OTHERWISE|SCAN|TRY|CATCH|FINALLY|WITH|DEFINE\s+CLASS|PROCEDURE|FUNCTION|ELSE|DO\s+WHILE)\b/i,
      decreaseIndentPattern:
        /^\s*(ENDIF|ENDFOR|ENDCASE|ENDSCAN|ENDTRY|ENDWITH|ENDDEFINE|ENDPROC|ENDFUNC|ELSE|OTHERWISE|CATCH|FINALLY)\b/i,
    },
    onEnterRules: [
      {
        beforeText: /^\s*\*.*$/,
        action: { indentAction: 0 },
      },
    ],
  });

  monaco.languages.setMonarchTokensProvider('foxpro', {
    ignoreCase: true,
    defaultToken: '',
    tokenPostfix: '.foxpro',
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/^\s*\*.*$/, 'comment'],
        [/&&.*$/, 'comment'],
        [/#\w+/, 'keyword.preprocessor'],
        [/[Tt][Hh][Ii][Ss][Ff][Oo][Rr][Mm][Ss][Ee][Tt]\b/, 'variable.language'],
        [/[Tt][Hh][Ii][Ss][Ff][Oo][Rr][Mm]\b/, 'variable.language'],
        [/[Tt][Hh][Ii][Ss]\b/, 'variable.language'],
        [/_[A-Za-z]\w*/, 'variable.language'],
        [/\.[TtFf]\./, 'constant'],
        [/\.[Nn][Uu][Ll][Ll]\./, 'constant'],
        [/[A-Za-z_]\w*(?=\s*\()/, 'type.identifier'],
        [/@?[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\.[A-Za-z_]\w*/, 'attribute.name'],
        [/\d+\.\d*([eE][+-]?\d+)?/, 'number.float'],
        [/\d+([eE][+-]?\d+)?/, 'number'],
        [/\$[0-9A-Fa-f]+/, 'number.hex'],
        [/0[xX][0-9A-Fa-f]+/, 'number.hex'],
        [/"/, { token: 'string.quote', bracket: '@open', next: '@double' }],
        [/'/, { token: 'string.quote', bracket: '@open', next: '@single' }],
        [/[{}()\[\]]/, '@brackets'],
        [/[;,]/, 'delimiter'],
        [/[=<>!+\-*/%^&|~:]/, 'operator'],
      ],
      double: [
        [/[^"]+/, 'string'],
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
      single: [
        [/[^']+/, 'string'],
        [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider('foxpro', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const dotMatch = /([A-Za-z_][\w]*)\s*\.\s*[\w]*$/.exec(before);
      if (dotMatch) {
        const owner = dotMatch[1].toLowerCase();
        const base = OWNER_ALIASES.get(owner) || owner;
        const pems = BASE_CLASS_SET.has(base) ? LANG.pemsFor(base) : LANG.pemsAll();
        const suggestions = [];
        for (const name of pems.properties || []) {
          suggestions.push({
            label: name,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: name,
            range,
            sortText: `0_${name}`,
            detail: 'Propriedade',
          });
        }
        for (const name of pems.events || []) {
          suggestions.push({
            label: name,
            kind: monaco.languages.CompletionItemKind.Event,
            insertText: name,
            range,
            sortText: `1_${name}`,
            detail: 'Evento',
          });
        }
        for (const name of pems.methods || []) {
          suggestions.push({
            label: name,
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: name,
            range,
            sortText: `2_${name}`,
            detail: 'Método',
          });
        }
        return { suggestions };
      }

      const suggestions = [];

      for (const keyword of KEYWORDS) {
        suggestions.push({
          label: keyword.toUpperCase(),
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword.toUpperCase(),
          range,
          sortText: `3_${keyword}`,
          detail: 'Comando',
        });
      }

      for (const fn of FUNCTION_BY_NAME.values()) {
        suggestions.push({
          label: String(fn.name).toUpperCase(),
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn.name,
          range,
          sortText: `2_${fn.name}`,
          detail: fn.sig || 'Função',
          documentation: fn.doc ? { value: fn.doc } : undefined,
        });
      }

      for (const name of LANG.BASE_CLASS_NAMES || []) {
        const display = (LANG.BASE_CLASS_DISPLAY && LANG.BASE_CLASS_DISPLAY[name]) || name;
        suggestions.push({
          label: display,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: display,
          range,
          sortText: `4_${name}`,
          detail: `Classe base (${name})`,
        });
      }

      for (const name of LANG.CONSTANTS || []) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Constant,
          insertText: name,
          range,
          sortText: `1_${name}`,
        });
      }

      for (const name of LANG.SYSTEM_VARS || []) {
        suggestions.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: name,
          range,
          sortText: `5_${name}`,
          detail: 'Variável de sistema',
        });
      }

      for (const snippet of SNIPPETS) {
        suggestions.push({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: `0_${snippet.label}`,
          detail: snippet.detail,
        });
      }

      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider('foxpro', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const key = word.word.toLowerCase();
      const fn = FUNCTION_BY_NAME.get(key);
      if (fn) {
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
          contents: [
            { value: `\`${fn.sig || fn.name}\`` },
            ...(fn.doc ? [{ value: fn.doc }] : []),
          ],
        };
      }
      const command = COMMAND_BY_NAME.get(key);
      if (command && command.sig) {
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
          contents: [{ value: `\`${command.sig}\`` }],
        };
      }
      return null;
    },
  });
}

export function applyEditorTheme(monaco) {
  if (editorThemeDefined) return;
  editorThemeDefined = true;
  monaco.editor.defineTheme('foxpro-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'keyword.preprocessor', foreground: 'C586C0' },
      { token: 'type.identifier', foreground: 'DCDCAA' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'string.quote', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'number.float', foreground: 'B5CEA8' },
      { token: 'number.hex', foreground: 'B5CEA8' },
      { token: 'constant', foreground: '4FC1FF' },
      { token: 'variable.language', foreground: 'C586C0' },
      { token: 'attribute.name', foreground: '9CDCFE' },
      { token: 'operator', foreground: 'D4D4D4' },
      { token: 'delimiter', foreground: 'D4D4D4' },
      { token: 'identifier', foreground: 'D4D4D4' },
    ],
    colors: {
      'editor.background': '#1f1f1f',
      'editor.foreground': '#cccccc',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#cccccc',
      'editorCursor.foreground': '#aeafad',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editor.lineHighlightBackground': '#2a2d2e',
      'editorIndentGuide.background1': '#404040',
      'editorIndentGuide.activeBackground1': '#707070',
      'editorWidget.background': '#202020',
      'editorWidget.border': '#454545',
      'editorSuggestWidget.background': '#202020',
      'editorSuggestWidget.border': '#454545',
      'editorSuggestWidget.selectedBackground': '#04395e',
      'editorSuggestWidget.highlightForeground': '#2f8ad3',
      'editorHoverWidget.background': '#202020',
      'editorHoverWidget.border': '#454545',
      'editorGutter.background': '#1f1f1f',
      'minimap.background': '#1f1f1f',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#79797966',
      'scrollbarSlider.hoverBackground': '#646464b3',
      'scrollbarSlider.activeBackground': '#bfbfbf66',
    },
  });
}

export function createEditor(monaco, container) {
  return monaco.editor.create(container, {
    theme: 'foxpro-dark',
    language: 'foxpro',
    automaticLayout: true,
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 20,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    renderWhitespace: 'selection',
    renderLineHighlight: 'all',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    padding: { top: 10, bottom: 10 },
    fixedOverflowWidgets: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on',
    tabCompletion: 'on',
    wordBasedSuggestions: 'currentDocument',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    overviewRulerBorder: false,
    contextmenu: true,
  });
}

export const VFP_COMPLETION_SNIPPETS = SNIPPETS;

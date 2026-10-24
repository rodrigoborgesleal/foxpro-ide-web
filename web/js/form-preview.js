'use strict';

import {
  createPreviewModel,
  getDefaultGeometry,
  isNonVisualBase,
  scaleFactorFor,
} from './form-parser.js';

const FORM_BASES = new Set(['form', 'formset', 'toolbar']);
const GROUP_BASES = new Set(['container', 'optiongroup', 'commandgroup']);
const TRANSPARENT_BY_DEFAULT = new Set(['label', 'checkbox', 'optionbutton']);

function lower(value) {
  return String(value ?? '').toLowerCase();
}

function number(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '.t.' || normalized === 'true' || normalized === '1') return true;
    if (normalized === '.f.' || normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function caption(value) {
  // O VFP usa "\<" para marcar a tecla de acesso; o preview exibe apenas o texto.
  return text(value).replace(/\\</g, '');
}

function safeFontName(value) {
  return String(value || 'Tahoma')
    .replace(/["'\\;]/g, '')
    .trim();
}

function color(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return fallback;
    const red = value & 0xff;
    const green = (value >> 8) & 0xff;
    const blue = (value >> 16) & 0xff;
    return `rgb(${red}, ${green}, ${blue})`;
  }

  const raw = String(value).trim();
  const rgbFunction = /^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(raw);
  if (rgbFunction) {
    return `rgb(${rgbFunction[1]}, ${rgbFunction[2]}, ${rgbFunction[3]})`;
  }

  const rgbList = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(raw);
  if (rgbList) {
    return `rgb(${rgbList[1]}, ${rgbList[2]}, ${rgbList[3]})`;
  }

  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
  if (/^[a-z]+$/i.test(raw)) return raw;
  return fallback;
}

function prop(node, name, fallback) {
  return Object.prototype.hasOwnProperty.call(node.properties || {}, name)
    ? node.properties[name]
    : fallback;
}

function nodeScale(node, ctx) {
  const mode = prop(node, 'ScaleMode', undefined);
  return scaleFactorFor(mode === undefined || mode === null || mode === '' ? ctx.formScaleMode : mode);
}

function px(value, scale, fallback = 0) {
  const numeric = number(value, fallback);
  return `${numeric * scale}px`;
}

function valueOf(node, name, fallback = '') {
  return prop(node, name, fallback);
}

function rowSourceValues(node) {
  const sourceType = number(prop(node, 'RowSourceType', 0), 0);
  if (sourceType !== 1) return [];
  const source = text(prop(node, 'RowSource', '')).trim();
  if (!source) return [];
  return source
    .split(',')
    .map((item) => item.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .filter((item) => item.length > 0);
}

function selectedRowIndex(node, rows) {
  const value = prop(node, 'Value', 0);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.min(rows.length, Math.trunc(value)) - 1 : -1;
  }
  if (typeof value === 'string') {
    const index = rows.findIndex((row) => row === value);
    if (index >= 0) return index;
  }
  return -1;
}

function make(tag, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function applyFont(element, node) {
  const fontName = safeFontName(prop(node, 'FontName', 'Tahoma'));
  element.style.fontFamily = `"${fontName}", Tahoma, "Segoe UI", sans-serif`;
  element.style.fontSize = `${number(prop(node, 'FontSize', 9), 9)}pt`;
  element.style.fontWeight = boolean(prop(node, 'FontBold', false), false) ? '700' : '400';
  element.style.fontStyle = boolean(prop(node, 'FontItalic', false), false) ? 'italic' : 'normal';
  const decorations = [];
  if (boolean(prop(node, 'FontUnderline', false), false)) decorations.push('underline');
  if (boolean(prop(node, 'FontStrikethru', false), false)) decorations.push('line-through');
  element.style.textDecoration = decorations.join(' ') || 'none';
  element.style.color = color(prop(node, 'ForeColor', null), '#000000');
}

function applyBackground(element, node, transparentByDefault = false) {
  const type = lower(node.standardBase);
  const backStyle = prop(node, 'BackStyle', undefined);
  const transparent =
    backStyle === 0 ||
    backStyle === '0' ||
    (backStyle === undefined && (transparentByDefault || TRANSPARENT_BY_DEFAULT.has(type)));

  if (transparent) {
    element.style.backgroundColor = 'transparent';
    return;
  }

  const fallback = type === 'form' ? '#f5f5f5' : '#ffffff';
  element.style.backgroundColor = color(prop(node, 'BackColor', null), fallback);
}

function applyBorder(element, node, ctx, fallbackStyle = 0) {
  const scale = nodeScale(node, ctx);
  const borderStyle = number(prop(node, 'BorderStyle', fallbackStyle), fallbackStyle);
  if (!borderStyle) {
    element.style.border = '0';
    return;
  }

  const styles = {
    1: 'solid',
    2: 'dashed',
    3: 'dotted',
    4: 'double',
  };
  const lineStyle = styles[borderStyle] || 'solid';
  const width = Math.max(1, number(prop(node, 'BorderWidth', 1), 1) * scale);
  const borderColor = color(
    prop(node, 'BorderColor', null),
    ['textbox', 'editbox', 'combobox', 'listbox', 'grid', 'spinner'].includes(
      lower(node.standardBase),
    )
      ? '#7f9db9'
      : '#808080',
  );
  element.style.border = `${width}px ${lineStyle} ${borderColor}`;
}

function applyBox(element, node, ctx, options = {}) {
  const scale = nodeScale(node, ctx);
  const geometry = getDefaultGeometry(node.standardBase);
  const autoSize = lower(node.standardBase) === 'label' && boolean(prop(node, 'AutoSize', false), false);

  element.style.position = 'absolute';
  element.style.left = px(prop(node, 'Left', 0), scale, 0);
  element.style.top = px(prop(node, 'Top', 0), scale, 0);

  if (autoSize && options.allowAutoSize !== false) {
    element.style.width = 'auto';
    element.style.height = 'auto';
  } else {
    element.style.width = px(prop(node, 'Width', geometry.width), scale, geometry.width);
    element.style.height = px(prop(node, 'Height', geometry.height), scale, geometry.height);
  }

  element.style.boxSizing = 'border-box';
}

function applyCommon(element, node, ctx, options = {}) {
  element.classList.add('fp-control', `fp-${node.standardBase}`);
  element.dataset.fpName = node.name;
  element.dataset.fpClass = node.baseClass;
  element.title =
    node.baseClass && lower(node.baseClass) !== lower(node.standardBase)
      ? `${node.name} — ${node.baseClass} (${node.standardBase})`
      : `${node.name} — ${node.standardBase}`;

  applyBox(element, node, ctx, options);
  applyBackground(element, node, options.transparentByDefault === true);
  applyFont(element, node);
  applyBorder(element, node, ctx, options.borderStyle || 0);

  if (!boolean(prop(node, 'Enabled', true), true)) {
    element.classList.add('fp-disabled');
    element.setAttribute('aria-disabled', 'true');
  }

  if (lower(node.standardBase) === 'label') {
    const alignment = number(prop(node, 'Alignment', 0), 0);
    element.style.textAlign = alignment === 1 ? 'right' : alignment === 2 ? 'center' : 'left';
    element.style.whiteSpace =
      boolean(prop(node, 'WordWrap', false), false) ? 'pre-wrap' : 'nowrap';
    element.style.overflow = 'hidden';
    if (boolean(prop(node, 'AutoSize', false), false)) {
      element.style.whiteSpace = 'nowrap';
    }
  }

  if (prop(node, 'ToolTipText', '')) {
    element.title = text(prop(node, 'ToolTipText'));
  }
}

function stat(ctx, key) {
  ctx.stats[key] = (ctx.stats[key] || 0) + 1;
}

function renderNode(parent, node, ctx) {
  if (!node || isNonVisualBase(node.standardBase)) return;
  if (!boolean(prop(node, 'Visible', true), true)) {
    stat(ctx, 'hidden');
    return;
  }

  const type = lower(node.standardBase);
  if (type === 'page' || type === 'column' || type === 'header') {
    // Esses objetos são renderizados pelo pageframe/grid.
    return;
  }

  stat(ctx, 'rendered');
  if (node.isCustom) stat(ctx, 'custom');
  if (!node.resolved) stat(ctx, 'unresolved');

  switch (type) {
    case 'label':
      renderLabel(parent, node, ctx);
      break;
    case 'commandbutton':
      renderCommandButton(parent, node, ctx);
      break;
    case 'textbox':
      renderTextBox(parent, node, ctx, false);
      break;
    case 'editbox':
      renderTextBox(parent, node, ctx, true);
      break;
    case 'checkbox':
      renderCheckBox(parent, node, ctx);
      break;
    case 'optionbutton':
      renderOptionButton(parent, node, ctx);
      break;
    case 'combobox':
      renderComboBox(parent, node, ctx);
      break;
    case 'listbox':
      renderListBox(parent, node, ctx);
      break;
    case 'spinner':
      renderSpinner(parent, node, ctx);
      break;
    case 'shape':
      renderShape(parent, node, ctx);
      break;
    case 'line':
      renderLine(parent, node, ctx);
      break;
    case 'image':
      renderImage(parent, node, ctx);
      break;
    case 'container':
      renderContainer(parent, node, ctx);
      break;
    case 'pageframe':
      renderPageFrame(parent, node, ctx);
      break;
    case 'grid':
      renderGrid(parent, node, ctx);
      break;
    case 'optiongroup':
      renderGroup(parent, node, ctx, 'fp-optiongroup');
      break;
    case 'commandgroup':
      renderGroup(parent, node, ctx, 'fp-commandgroup');
      break;
    case 'hyperlink':
      renderHyperlink(parent, node, ctx);
      break;
    case 'olecontrol':
    case 'oleboundcontrol':
      renderOlePlaceholder(parent, node, ctx);
      break;
    default:
      renderUnknown(parent, node, ctx);
      break;
  }
}

function renderLabel(parent, node, ctx) {
  const element = make('div', 'fp-label');
  applyCommon(element, node, ctx, { transparentByDefault: true });
  element.textContent = caption(valueOf(node, 'Caption', node.name));
  parent.appendChild(element);
}

function renderCommandButton(parent, node, ctx) {
  const element = make('button', 'fp-commandbutton');
  element.type = 'button';
  element.tabIndex = -1;
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.textContent = caption(valueOf(node, 'Caption', node.name));
  if (boolean(prop(node, 'Default', false), false)) element.classList.add('fp-default');
  if (boolean(prop(node, 'Cancel', false), false)) element.classList.add('fp-cancel');
  if (!element.style.backgroundColor || element.style.backgroundColor === 'transparent') {
    element.style.backgroundColor = '#e1e1e1';
  }
  parent.appendChild(element);
}

function renderTextBox(parent, node, ctx, multiline) {
  const element = make('div', multiline ? 'fp-editbox' : 'fp-textbox');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.display = 'flex';
  element.style.alignItems = multiline ? 'flex-start' : 'center';
  element.style.justifyContent =
    number(prop(node, 'Alignment', 0), 0) === 1
      ? 'flex-end'
      : number(prop(node, 'Alignment', 0), 0) === 2
        ? 'center'
        : 'flex-start';
  element.style.padding = '1px 3px';
  element.style.overflow = 'hidden';
  element.style.whiteSpace = multiline ? 'pre-wrap' : 'nowrap';
  element.style.textOverflow = multiline ? 'clip' : 'ellipsis';
  if (boolean(prop(node, 'ReadOnly', false), false)) element.classList.add('fp-readonly');

  const passwordChar = text(prop(node, 'PasswordChar', ''));
  const value = text(valueOf(node, 'Value', ''));
  element.textContent = passwordChar ? passwordChar.repeat(Math.min(value.length, 40)) : value;
  parent.appendChild(element);
}

function renderCheckBox(parent, node, ctx) {
  const element = make('label', 'fp-checkbox');
  applyCommon(element, node, ctx, { transparentByDefault: true });
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.gap = '4px';
  element.style.overflow = 'hidden';

  const box = make('span', 'fp-check-box');
  const checked = boolean(prop(node, 'Value', false), false);
  if (checked) box.textContent = '✓';
  box.setAttribute('aria-hidden', 'true');

  const label = make('span', 'fp-check-caption');
  label.textContent = caption(valueOf(node, 'Caption', node.name));
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';

  element.append(box, label);
  parent.appendChild(element);
}

function renderOptionButton(parent, node, ctx) {
  const element = make('label', 'fp-optionbutton');
  applyCommon(element, node, ctx, { transparentByDefault: true });
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.gap = '4px';
  element.style.overflow = 'hidden';

  const dot = make('span', 'fp-option-dot');
  const selected = boolean(prop(node, 'Value', false), false);
  if (selected) dot.classList.add('is-selected');
  dot.setAttribute('aria-hidden', 'true');

  const label = make('span', 'fp-option-caption');
  label.textContent = caption(valueOf(node, 'Caption', node.name));
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';

  element.append(dot, label);
  parent.appendChild(element);
}

function renderComboBox(parent, node, ctx) {
  const element = make('div', 'fp-combobox');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.padding = '0 4px';
  element.style.overflow = 'hidden';

  const rows = rowSourceValues(node);
  const selected = selectedRowIndex(node, rows);
  const rawValue = valueOf(node, 'Value', '');
  let display = text(rawValue);
  if (!display && rows.length) display = rows[0];
  if (typeof rawValue === 'number' && rows.length && selected >= 0) display = rows[selected];

  const value = make('span', 'fp-combo-value');
  value.textContent = display;
  value.style.flex = '1';
  value.style.overflow = 'hidden';
  value.style.textOverflow = 'ellipsis';
  value.style.whiteSpace = 'nowrap';

  const arrow = make('span', 'fp-combo-arrow');
  arrow.textContent = '▾';
  arrow.setAttribute('aria-hidden', 'true');

  element.append(value, arrow);
  parent.appendChild(element);
}

function renderListBox(parent, node, ctx) {
  const element = make('div', 'fp-listbox');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.overflow = 'hidden';
  element.style.padding = '2px';

  const rows = rowSourceValues(node);
  const selected = selectedRowIndex(node, rows);

  if (!rows.length) {
    const empty = make('div', 'fp-listbox-empty');
    empty.textContent = text(valueOf(node, 'Value', '')) || 'ListBox';
    element.appendChild(empty);
  } else {
    rows.slice(0, 30).forEach((row, index) => {
      const item = make('div', 'fp-listbox-row');
      if (index === selected) item.classList.add('is-selected');
      item.textContent = row;
      element.appendChild(item);
    });
  }

  parent.appendChild(element);
}

function renderSpinner(parent, node, ctx) {
  const element = make('div', 'fp-spinner');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.padding = '0 2px 0 4px';
  element.style.overflow = 'hidden';

  const value = make('span', 'fp-spinner-value');
  value.textContent = text(valueOf(node, 'Value', 0));
  value.style.flex = '1';

  const buttons = make('span', 'fp-spinner-buttons');
  buttons.textContent = '▲▼';
  buttons.setAttribute('aria-hidden', 'true');

  element.append(value, buttons);
  parent.appendChild(element);
}

function renderShape(parent, node, ctx) {
  const element = make('div', 'fp-shape');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  const shape = number(prop(node, 'Shape', 0), 0);
  if (shape === 2 || shape === 3) element.style.borderRadius = '50%';
  else if (shape === 4 || shape === 5) element.style.borderRadius = '6px';
  if (number(prop(node, 'FillStyle', 0), 0) === 1) {
    element.style.backgroundColor = 'transparent';
  }
  parent.appendChild(element);
}

function renderLine(parent, node, ctx) {
  const scale = nodeScale(node, ctx);
  const width = Math.max(1, number(prop(node, 'Width', 100), 100) * scale);
  const height = Math.max(1, number(prop(node, 'Height', 1), 1) * scale);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('fp-control', 'fp-line');
  svg.dataset.fpName = node.name;
  svg.dataset.fpClass = node.baseClass;
  svg.style.position = 'absolute';
  svg.style.left = px(prop(node, 'Left', 0), scale, 0);
  svg.style.top = px(prop(node, 'Top', 0), scale, 0);
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.style.overflow = 'visible';
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', node.name);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  const slant = text(prop(node, 'LineSlant', '\\'));
  line.setAttribute('x1', '0');
  line.setAttribute('y1', slant === '/' ? String(height) : '0');
  line.setAttribute('x2', String(width));
  line.setAttribute('y2', slant === '/' ? '0' : String(height));
  line.setAttribute('stroke', color(prop(node, 'BorderColor', null), '#000000'));
  line.setAttribute('stroke-width', String(Math.max(1, number(prop(node, 'BorderWidth', 1), 1) * scale)));
  svg.appendChild(line);
  parent.appendChild(svg);
}

function renderImage(parent, node, ctx) {
  const element = make('div', 'fp-image');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.overflow = 'hidden';
  element.style.display = 'flex';
  element.style.flexDirection = 'column';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.gap = '2px';
  element.style.color = '#666';
  element.classList.add('fp-approximate');
  stat(ctx, 'approximate');

  const picture = text(prop(node, 'Picture', ''));
  if (/^data:image\/(?:png|jpe?g|gif|bmp|webp);base64,/i.test(picture)) {
    const img = make('img', 'fp-image-content');
    img.src = picture;
    img.alt = node.name;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.objectFit = 'contain';
    element.appendChild(img);
  } else {
    const icon = make('span', 'fp-image-icon');
    icon.textContent = '▧';
    const label = make('span', 'fp-image-label');
    label.textContent = picture || 'Imagem';
    element.append(icon, label);
  }

  parent.appendChild(element);
}

function renderContainer(parent, node, ctx) {
  const element = make('div', 'fp-container');
  applyCommon(element, node, ctx, { borderStyle: 0 });
  element.style.overflow = 'hidden';
  for (const child of node.children || []) renderNode(element, child, ctx);
  parent.appendChild(element);
}

function renderGroup(parent, node, ctx, className) {
  const element = make('div', className);
  applyCommon(element, node, ctx, { borderStyle: 0, transparentByDefault: true });
  element.style.overflow = 'hidden';
  for (const child of node.children || []) renderNode(element, child, ctx);
  parent.appendChild(element);
}

function renderPageFrame(parent, node, ctx) {
  const element = make('div', 'fp-pageframe');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.overflow = 'hidden';

  const pages = (node.children || []).filter((child) => lower(child.standardBase) === 'page');
  const tabs = boolean(prop(node, 'Tabs', true), true);
  const scale = nodeScale(node, ctx);
  const tabHeight = tabs ? Math.max(16, number(prop(node, 'TabHeight', 20), 20) * scale) : 0;
  const tabsElement = make('div', 'fp-page-tabs');
  tabsElement.style.height = `${tabHeight}px`;
  tabsElement.style.display = tabs ? 'flex' : 'none';
  tabsElement.style.alignItems = 'flex-end';
  tabsElement.style.padding = '0 3px';
  tabsElement.style.gap = '2px';
  tabsElement.style.borderBottom = '1px solid #808080';
  tabsElement.style.backgroundColor = '#d4d0c8';

  const content = make('div', 'fp-page-content');
  content.style.position = 'absolute';
  content.style.left = '0';
  content.style.right = '0';
  content.style.bottom = '0';
  content.style.top = `${tabHeight}px`;
  content.style.overflow = 'hidden';
  content.style.backgroundColor = '#f5f5f5';

  if (!pages.length) {
    const empty = make('div', 'fp-page-empty');
    empty.textContent = 'PageFrame sem páginas no .sc2';
    content.appendChild(empty);
  } else {
    let activeIndex = Math.max(0, Math.min(pages.length - 1, number(prop(node, 'ActivePage', 1), 1) - 1));
    const panelList = [];

    pages.forEach((page, index) => {
      const tab = make('button', 'fp-page-tab');
      tab.type = 'button';
      tab.textContent = caption(valueOf(page, 'Caption', page.name));
      tab.tabIndex = -1;
      tab.setAttribute('aria-selected', String(index === activeIndex));
      if (index === activeIndex) tab.classList.add('is-active');

      const panel = make('div', 'fp-page-panel');
      panel.style.position = 'absolute';
      panel.style.inset = '0';
      panel.style.overflow = 'hidden';
      panel.style.backgroundColor = color(prop(page, 'BackColor', null), '#f5f5f5');
      panel.style.display = index === activeIndex ? 'block' : 'none';

      for (const child of page.children || []) renderNode(panel, child, ctx);
      panelList.push(panel);
      content.appendChild(panel);

      tab.addEventListener('click', () => {
        activeIndex = index;
        panelList.forEach((item, itemIndex) => {
          item.style.display = itemIndex === activeIndex ? 'block' : 'none';
        });
        for (const otherTab of tabsElement.querySelectorAll('.fp-page-tab')) {
          const isActive = Number(otherTab.dataset.pageIndex) === activeIndex;
          otherTab.classList.toggle('is-active', isActive);
          otherTab.setAttribute('aria-selected', String(isActive));
        }
      });
      tab.dataset.pageIndex = String(index);
      tabsElement.appendChild(tab);
    });
  }

  element.append(tabsElement, content);
  parent.appendChild(element);
}

function renderGrid(parent, node, ctx) {
  const element = make('div', 'fp-grid');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.overflow = 'hidden';
  element.style.backgroundColor = '#ffffff';

  const columns = (node.children || []).filter((child) => lower(child.standardBase) === 'column');
  const columnCount = Math.max(columns.length, number(prop(node, 'ColumnCount', 0), 0), 1);
  const table = make('table', 'fp-grid-table');
  table.style.width = '100%';
  table.style.height = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.tableLayout = 'fixed';
  const colgroup = make('colgroup');
  const head = make('thead');
  const headRow = make('tr');
  const body = make('tbody');

  for (let index = 0; index < columnCount; index += 1) {
    const column = columns[index];
    const header = column
      ? (column.children || []).find((child) => lower(child.standardBase) === 'header')
      : null;
    const columnWidth = column ? number(prop(column, 'Width', 0), 0) : 0;
    const col = make('col');
    if (columnWidth > 0) col.style.width = px(columnWidth, nodeScale(column, ctx), columnWidth);
    colgroup.appendChild(col);

    const th = make('th', 'fp-grid-header');
    th.textContent = caption(
      header ? valueOf(header, 'Caption', `Column${index + 1}`) : `Column${index + 1}`,
    );
    headRow.appendChild(th);
  }

  const rowHeight = 20;
  const estimatedHeight = Math.max(40, number(prop(node, 'Height', 150), 150) * nodeScale(node, ctx));
  const rowCount = Math.max(1, Math.min(12, Math.floor((estimatedHeight - 22) / rowHeight)));
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = make('tr');
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = make('td', 'fp-grid-cell');
      cell.textContent = '';
      row.appendChild(cell);
    }
    body.appendChild(row);
  }

  head.appendChild(headRow);
  table.append(colgroup, head, body);
  element.appendChild(table);
  parent.appendChild(element);
}

function renderHyperlink(parent, node, ctx) {
  const element = make('div', 'fp-hyperlink');
  applyCommon(element, node, ctx, { transparentByDefault: true });
  element.style.color = '#0066cc';
  element.style.textDecoration = 'underline';
  element.style.overflow = 'hidden';
  element.style.whiteSpace = 'nowrap';
  element.textContent = caption(valueOf(node, 'Caption', node.name));
  parent.appendChild(element);
}

function renderOlePlaceholder(parent, node, ctx) {
  const element = make('div', 'fp-ole');
  applyCommon(element, node, ctx, { borderStyle: 1 });
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.overflow = 'hidden';
  element.style.color = '#666';
  element.style.backgroundColor = '#f4f4f4';
  element.classList.add('fp-approximate');
  stat(ctx, 'approximate');
  const className = text(prop(node, 'OLEClass', prop(node, 'Class', node.baseClass)));
  element.textContent = `OLE: ${className || node.name}`;
  parent.appendChild(element);
}

function renderUnknown(parent, node, ctx) {
  const element = make('div', 'fp-unknown');
  applyCommon(element, node, ctx, { borderStyle: 1, transparentByDefault: false });
  element.style.borderStyle = 'dashed';
  element.style.overflow = 'hidden';
  element.classList.add('fp-approximate');
  stat(ctx, 'approximate');

  const label = make('span', 'fp-unknown-label');
  label.textContent = node.baseClass || node.standardBase || 'Custom';
  element.appendChild(label);

  for (const child of node.children || []) renderNode(element, child, ctx);
  parent.appendChild(element);
}

function statusText(model, stats) {
  const parts = [`${stats.rendered || 0} controle(s)`];
  if (stats.approximate) parts.push(`${stats.approximate} aproximado(s)`);
  if (stats.hidden) parts.push(`${stats.hidden} oculto(s)`);
  if (stats.unresolved) parts.push(`${stats.unresolved} classe(s) não resolvida(s)`);
  return parts.join(' · ');
}

export function createFormPreviewController({ stage, meta, status, zoomLabel }) {
  let currentModel = null;
  let currentZoom = 1;
  let autoFit = true;
  let currentPath = '';
  let lastContent = '';
  let lastFiles = [];
  let resizeFrame = null;

  function clear() {
    currentModel = null;
    currentPath = '';
    lastContent = '';
    lastFiles = [];
    currentZoom = 1;
    autoFit = true;
    if (stage) stage.innerHTML = '';
    if (meta) meta.textContent = 'Preview experimental';
    if (status) status.textContent = '';
    if (zoomLabel) zoomLabel.textContent = '100%';
  }

  function applyZoom(nextZoom) {
    if (!currentModel || !stage) return;
    currentZoom = Math.max(0.25, Math.min(2, nextZoom));
    const scaler = stage.querySelector('.fp-scaler');
    const canvas = stage.querySelector('.fp-canvas');
    if (!scaler || !canvas) return;
    scaler.style.width = `${currentModel.width * currentZoom}px`;
    scaler.style.height = `${currentModel.height * currentZoom}px`;
    canvas.style.transform = `scale(${currentZoom})`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  function fit() {
    if (!currentModel || !stage) return;
    autoFit = true;
    const rect = stage.getBoundingClientRect();
    const availableWidth = Math.max(80, rect.width - 48);
    const availableHeight = Math.max(80, rect.height - 48);
    const nextZoom = Math.min(
      1,
      availableWidth / Math.max(1, currentModel.width),
      availableHeight / Math.max(1, currentModel.height),
    );
    applyZoom(nextZoom);
  }

  function setZoom(nextZoom) {
    autoFit = false;
    applyZoom(nextZoom);
  }

  function renderEmpty(title, message, warnings = []) {
    clear();
    if (!stage) return;
    const box = make('div', 'fp-empty');
    const titleElement = make('h2', 'fp-empty-title');
    titleElement.textContent = title;
    const messageElement = make('p', 'fp-empty-message');
    messageElement.textContent = message;
    box.append(titleElement, messageElement);
    if (warnings.length) {
      const warningElement = make('p', 'fp-empty-warning');
      warningElement.textContent = warnings[0];
      box.appendChild(warningElement);
    }
    stage.appendChild(box);
    if (meta) meta.textContent = 'Preview experimental';
    if (status) status.textContent = 'Não foi possível renderizar o formulário.';
    if (zoomLabel) zoomLabel.textContent = '—';
  }

  function render({ content, files, path, fit: shouldFit = false }) {
    const source = String(content ?? '');
    const fileList = Array.isArray(files) ? files : [];
    currentPath = String(path || '');
    lastContent = source;
    lastFiles = fileList;

    let model;
    try {
      model = createPreviewModel(source, fileList, { activePath: currentPath });
    } catch (error) {
      console.error('Falha ao interpretar .sc2:', error);
      renderEmpty(
        'Erro no preview',
        'O conteúdo do formulário não pôde ser interpretado como .sc2.',
        [error.message || String(error)],
      );
      return;
    }

    if (!model.ok) {
      renderEmpty('Formulário não encontrado', model.error, model.warnings || []);
      return;
    }

    currentModel = model;
    autoFit = true;
    if (stage) stage.innerHTML = '';

    const scaler = make('div', 'fp-scaler');
    const canvas = make('div', 'fp-canvas');
    canvas.style.width = `${model.width}px`;
    canvas.style.height = `${model.height}px`;
    canvas.style.backgroundColor = color(prop({ properties: model.properties }, 'BackColor', null), '#f5f5f5');
    canvas.style.transformOrigin = 'top left';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Preview do formulário ${model.name}`);

    const ctx = {
      formScaleMode: model.scaleMode,
      stats: { rendered: 0, approximate: 0, hidden: 0, unresolved: 0, custom: 0 },
    };

    for (const child of model.children || []) renderNode(canvas, child, ctx);

    scaler.appendChild(canvas);
    if (stage) stage.appendChild(scaler);

    if (meta) {
      meta.textContent = `${model.name} · ${Math.round(model.width)} × ${Math.round(
        model.height,
      )} px`;
    }
    if (status) {
      const warnings = model.warnings || [];
      const summary = statusText(model, ctx.stats);
      status.textContent = warnings.length ? `${summary} · ${warnings[0]}` : summary;
      status.classList.toggle('has-warnings', warnings.length > 0);
      status.title = warnings.join('\n');
    }
    if (zoomLabel) zoomLabel.textContent = '100%';

    // requestAnimationFrame garante que o stage já tenha dimensões quando o
    // preview foi aberto a partir de uma aba oculta.
    requestAnimationFrame(() => {
      if (!currentModel) return;
      if (shouldFit || autoFit) fit();
      else applyZoom(currentZoom);
    });
  }

  function refresh() {
    if (!currentPath) return;
    render({
      content: lastContent,
      files: lastFiles,
      path: currentPath,
      fit: false,
    });
  }

  function onResize() {
    if (!autoFit || !currentModel) return;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      fit();
    });
  }

  window.addEventListener('resize', onResize);

  return {
    render,
    clear,
    fit,
    setZoom,
    refresh,
    getModel: () => currentModel,
    getZoom: () => currentZoom,
    destroy() {
      window.removeEventListener('resize', onResize);
      clear();
    },
  };
}

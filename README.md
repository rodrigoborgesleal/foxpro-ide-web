# FoxPro IDE Web

IDE web para abrir, editar e recompilar projetos Visual FoxPro (`.pjx`/`.pjt`) usando o
[FoxBin2Prg](https://github.com/fdbozzo/foxbin2prg) embutido no bridge local.

O projeto é composto por dois componentes:

- **Web IDE** (`web/`): Monaco Editor com tema Dark Modern inspirado no VS Code, activity
  bar, árvore de arquivos, abas, marcador `M` de arquivos modificados, persistência em
  `LocalStorage` e exportação para LLMs.
- **Local Bridge Service** (`server/`): servidor HTTP em `127.0.0.1`, API REST, ícone na
  bandeja do Windows, janela de configurações no estilo do VS Code, logs rotativos e
  runtime do FoxBin2Prg.

> O projeto original **não é alterado**. A importação cria um workspace isolado em
> `%APPDATA%\FoxProIDEWeb\workspaces\<id>`, contendo apenas os membros do projeto e
> arquivos de apoio.

---

## Requisitos

| Item | Observação |
| --- | --- |
| Windows 10/11 x64 | O bridge e o empacotamento usam recursos do Windows. |
| Node.js 18+ | Necessário apenas para desenvolvimento e build. |
| Visual FoxPro 9 | **Obrigatório** para importar/recompilar. O FoxBin2Prg é um programa VFP e precisa do `vfp9.exe` instalado. |
| Navegador moderno | Chrome, Edge ou Firefox com suporte a ES modules e Monaco. |

O `vfp9.exe` é detectado automaticamente em `C:\Program Files (x86)\Microsoft Visual
FoxPro 9\vfp9.exe`. Se estiver em outro local, informe o caminho na janela de
configurações do systray.

### Sobre "zero dependência"

O bridge empacota o **FoxBin2Prg** e seus arquivos de configuração, mas não empacota o
Visual FoxPro. Na prática, a máquina ainda precisa ter o VFP 9 instalado para executar as
conversões. O executável empacotado não requer Node.js nem Python.

---

## Instalação para desenvolvimento

```powershell
# dependências do frontend (Monaco)
npm install

# dependências do bridge (Electron + electron-builder)
npm run install:server
```

O Monaco já está versionado em `web/vendor/monaco/vs` (0.57.0). Para atualizar:

```powershell
npm install monaco-editor@0.57.0
Remove-Item web\vendor\monaco\vs -Recurse -Force
Copy-Item node_modules\monaco-editor\min\vs web\vendor\monaco\vs -Recurse
```

### Subir apenas o bridge + IDE (sem systray)

```powershell
npm start
```

Abra <http://127.0.0.1:8080/>. O bridge também serve a IDE, portanto não é necessário um
servidor web separado.

### Subir com o ícone na bandeja

```powershell
npm run tray
```

O ícone abre o menu com status, iniciar/parar servidor, abrir IDE, configurações, logs e
pasta de projetos. Na primeira execução a janela de configurações é aberta.

### Build do executável

```powershell
npm run pack            # pasta server/dist/win-unpacked
npm run dist            # executável portátil
npm run dist:installer  # instalador NSIS
```

O pacote inclui `resources/web` (frontend) e `resources/assets` (ícones). O FoxBin2Prg
fica dentro do `app.asar` e é copiado para `%TEMP%` em tempo de execução, pois o VFP não
consegue executar arquivos de dentro do ASAR.

---

## Configuração

Arquivo: `%APPDATA%\FoxProIDEWeb\config.json`

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "vfpPath": "",
  "timeoutMs": 300000,
  "autoStart": true,
  "launchAtLogin": false,
  "keepJobs": false,
  "debug": false,
  "openIdeOnStart": false
}
```

A porta e as demais opções podem ser alteradas na janela de configurações. Ao mudar a
porta com o servidor online, ele é reiniciado automaticamente. Atualize também o endereço
do servidor na IDE (ícone de engrenagem na activity bar ou menu **Configurar servidor**)
caso ela esteja aberta.

### Variáveis de ambiente

| Variável | Efeito |
| --- | --- |
| `FPIW_PORT` | Porta HTTP (sobrepõe o config). |
| `FPIW_HOST` | Host de escuta; o padrão e valor recomendado é `127.0.0.1`. |
| `FPIW_VFP` | Caminho do `vfp9.exe`. |
| `FPIW_TIMEOUT_MS` | Timeout das execuções do VFP. |
| `FPIW_CONFIG` | Caminho alternativo do `config.json`. |
| `FPIW_CONFIG_DIR` | Pasta de dados alternativa. |
| `FPIW_WEB_DIR` | Pasta do frontend servido pelo bridge. |
| `FPIW_KEEP=1` | Mantém as pastas de build/verificação para diagnóstico. |
| `FPIW_MAX_BODY` | Tamanho máximo do corpo JSON em bytes. |

### Dados gerados

```
%APPDATA%\FoxProIDEWeb\
  config.json
  logs\app.log          # rotativo ao passar de 2 MB (app.log.1)
  workspaces\<id>\      # cópia isolada do projeto + .fpi (builds e último ZIP)
```

O polling periódico de `GET /api/status` feito pela IDE não é gravado no `app.log`; as
demais rotas da API continuam sendo registradas.

---

## Fluxo de uso

1. **Importar projeto** (`.pjx` ou `.pjt`). O bridge copia o projeto para um workspace e
   converte os binários com FoxBin2Prg:
   - `.pjx` → `.pj2`
   - `.scx` → `.sc2`, `.vcx` → `.vc2`, `.frx` → `.fr2`, `.mnx` → `.mn2`, `.lbx` → `.lb2`
2. **Editar** os textos na IDE. Arquivos que diferem da última compilação (ou da
   importação) recebem o marcador `M` na aba e na árvore. `Ctrl+S` salva no workspace e
   mantém o `M`; o ponto na aba indica apenas alterações ainda não salvas. O estado
   também fica no `LocalStorage`.
3. **Compilar Modificados** (`Ctrl+Shift+B`). Todos os arquivos marcados com `M` são
   enviados ao bridge, estejam salvos ou não. Ele:
   - salva o texto atual no workspace;
   - converte texto → binário com FoxBin2Prg (`.sc2`, `.vc2`, `.fr2`, `.mn2`, `.lb2`,
     `.pj2`);
   - reexporta o binário e compara o texto normalizado (verificação round-trip);
   - inclui os `.prg` alterados como arquivos gerados no relatório e no `.zip`;
   - inclui `.h`, `.ini` e `.txt` alterados no `.zip` como arquivos de apoio, sem
     contá-los como compilados;
   - gera um `.zip` com os binários recompilados e os fontes atualizados.
   O `M` só é removido dos arquivos processados com sucesso; em caso de falha ele
   permanece para uma nova tentativa.
4. **Baixar ZIP** e copiar o conteúdo para a pasta do projeto original (fora do
   workspace), depois de conferir no VFP. Os `.prg` copiados são recompilados pelo VFP
   ao gerar o APP/EXE. O bridge não escreve na pasta original.
5. **Exportar para LLM** pelo menu **Arquivo**:
   - arquivo `.txt` único;
   - arquivos `.txt` separados por categoria;
   - `.zip` com os arquivos particionados.

### Preview experimental de formulários

Ao abrir um arquivo `.sc2`, a IDE mostra a barra **Visualização do formulário**
com as opções **Código** e **Preview**. O recurso está identificado como
**Experimental**.

O preview:

- é somente leitura e não executa código VFP, métodos, queries ou data environment;
- interpreta `DEFINE CLASS`, `ADD OBJECT`, objetos aninhados, `PageN.*` e `ColumnN.*`;
- resolve classes customizadas a partir dos `.vc2` carregados no workspace;
- renderiza formulários, labels, botões, caixas de texto, checkboxes, combos, listas,
  shapes, linhas, containers, pageframes, grids, imagens e grupos;
- mostra placeholder tracejado para classes não resolvidas e controles OLE/ActiveX;
- permite zoom, ajuste automático e atualização manual.

O preview é uma aproximação visual. Fontes, temas, DPI, imagens externas e controles
nativos podem diferir do VFP. Ele não altera o `.sc2` nem o fluxo normal de salvar e
compilar.

### Exportação para LLM

O formato segue os delimitadores do PRD:

```
================================================================================
[PROJECT_METADATA]
PROJECT_NAME: MeuProjeto.pjx
EXPORT_DATE: 2026-10-23
TOTAL_FILES: 12
================================================================================

================================================================================
<<< START_CATEGORY: MAIN_PROGRAM >>>
================================================================================

--- BEGIN_FILE: main.prg | TYPE: PRG ---
...
--- END_FILE: main.prg ---

================================================================================
<<< END_CATEGORY: MAIN_PROGRAM >>>
================================================================================
```

Categorias: `MAIN_PROGRAM`, `PROGRAMS`, `FORMS`, `CLASSES`, `REPORTS`, `MENUS`,
`OTHERS`. Os nomes dos arquivos particionados incluem o nome do projeto, por exemplo
`MeuProjeto_main.txt`, `MeuProjeto_programas.txt`, `MeuProjeto_formularios.txt`.

---

## API REST

O servidor escuta apenas em loopback. Todas as respostas são JSON, exceto o download do
ZIP.

| Método | Endpoint | Descrição |
| --- | --- | --- |
| `GET` | `/api/status` | Saúde do serviço, VFP detectado, versão do FoxBin2Prg e capacidades. Consultado em polling pela IDE e não registrado no log. |
| `GET` | `/api/logs?lines=200` | Últimas linhas do `app.log`. |
| `POST` | `/api/project/import` | `{ "path": "C:\\Projeto\\App.pjx" }` → workspace + arquivos texto. |
| `GET` | `/api/project/list` | Lista workspaces recentes. |
| `GET` | `/api/project/load?id=<id>` | Carrega workspace e conteúdo dos arquivos. |
| `POST` | `/api/project/save` | `{ "id": "...", "files": [{ "path": "...", "content": "..." }] }`. |
| `POST` | `/api/project/compile` | `{ "id": "...", "files": [{ "path": "...", "content": "..." }] }` → relatório + ZIP. |
| `GET` | `/api/project/download?id=<id>` | Baixa o último ZIP compilado. |
| `DELETE` | `/api/project?id=<id>` | Remove o workspace (não afeta o projeto original). |
| `GET` | `/api/fs/list?path=C:\\Projetos` | Navegação de pastas para o seletor de `.pjx`. |

Exemplo de compilação:

```powershell
$body = @{
  id = "20261024000000-meuapp-abc123"
  files = @(@{ path = "mainform.sc2"; content = (Get-Content mainform.sc2 -Raw) })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/project/compile `
  -ContentType application/json -Body $body
```

O resultado inclui `files[].ok`, `files[].verification.identical` e o link para download
do ZIP. Entradas de `.prg` têm `files[].source = true` e `outputs = [<prg>]`; entram em
`stats.targets`/`stats.compiled` e no ZIP. `stats.binaryTargets`, `stats.sources` e
`stats.supportFiles` detalham, respectivamente, os alvos FoxBin2Prg, os `.prg`
atualizados e os arquivos de apoio incluídos.

### Segurança

- Escuta somente em `127.0.0.1`.
- Rejeita requisições cujo cabeçalho `Host` não seja `127.0.0.1`, `localhost` ou `::1`
  (proteção contra DNS rebinding).
- CORS é liberado apenas para origens de loopback. A IDE deve ser aberta pelo endereço
  servido pelo próprio bridge.
- Não há autenticação. Qualquer processo local consegue acessar a API; não exponha a
  porta em rede pública nem faça proxy dela.

---

## Estrutura do repositório

```
server/
  server.js            # HTTP, API, estáticos, CORS/Host
  core.js              # import, save, compile, FoxBin2Prg, cp1252, ZIP
  config.js            # configuração e caminhos
  log.js               # log rotativo
  zip.js               # escrita de ZIP sem dependências externas
  vfp/fb2p_batch.prg   # lote executado dentro do VFP
  vendor/foxbin2prg/   # FoxBin2Prg 1.21.05 embutido
  systray/             # Electron: bandeja, configurações, preload
web/
  index.html
  css/app.css
  js/app.js            # estado da IDE, abas, árvore, import/compile/export
  js/api.js            # cliente HTTP
  js/store.js          # LocalStorage
  js/exporter.js       # formato LLM
  js/form-parser.js    # parser de .sc2/.vc2 e modelo do preview
  js/form-preview.js   # renderer HTML/CSS somente leitura
  js/vfp-monaco.js     # linguagem VFP, tema e autocomplete
  js/zip.js            # ZIP no navegador
  vendor/monaco/       # Monaco 0.57.0
```

---

## Limitações conhecidas

- **VFP 9 é obrigatório** para importar/compilar; o pacote não inclui o runtime do VFP.
- Codificação de texto fixa em **cp1252**. Caracteres fora dessa página de código são
  rejeitados ao salvar/compilar com uma mensagem explícita.
- Bancos de dados (`.dbc`, `.dbf`) são copiados, mas não convertidos nem editáveis pela
  IDE.
- A compilação altera apenas os arquivos marcados; dependências não marcadas usam o
  estado atual do workspace.
- Os `.prg` não são convertidos em `.fxp` pelo bridge: o ZIP entrega o fonte atualizado
  e o VFP o compila ao gerar o APP/EXE.
- O ZIP gerado precisa ser copiado manualmente para a pasta do projeto original. Não há
  escrita direta na pasta de origem.
- Projetos muito grandes podem esbarrar no limite do `LocalStorage`; o aviso aparece na
  interface e o conteúdo continua em memória até ser salvo no servidor.
- A janela de configurações do systray é Windows-only.
- O executável portátil não é assinado digitalmente; o Windows SmartScreen pode exibir um
  aviso na primeira execução. O portátil também extrai os arquivos para `%TEMP%` antes de
  abrir, o que pode levar alguns segundos.
- A exportação para LLM usa o conteúdo atual em memória, incluindo edições ainda não
  salvas.
- O preview de formulários é **experimental e aproximado**. Não é um form designer:
  não move, redimensiona nem altera controles. OLE/ActiveX, classes externas não
  carregadas e imagens referenciadas por caminho aparecem como placeholder.
- O Monaco 0.57.0 empacota uma versão do DOMPurify com avisos de segurança conhecidos.
  A IDE não renderiza o conteúdo dos arquivos como HTML/Markdown, então a superfície
  afetada não é usada; o aviso desaparece quando o Monaco for atualizado.

---

## Diagnóstico

- **Logs**: menu do systray → **Abrir logs**, ou <http://127.0.0.1:8080/api/logs>.
- **VFP não encontrado**: confira o caminho em **Configurações** e use **Testar**.
- **Porta em uso**: altere a porta no systray ou encerre o processo que a utiliza.
- **Compilação falhou**: ative `debug` nas configurações para incluir detalhes no log;
  `FPIW_KEEP=1` preserva as pastas `.fpi/build-*` e `.fpi/verify-*`.
- **Workspace removido**: a IDE descarta a sessão antiga e mostra a tela inicial; importe
  o projeto novamente.
- **`M` não sai ao salvar**: é o comportamento esperado. O marcador indica diferença em
  relação ao último binário compilado; salvar apenas persiste o texto. Compile para
  removê-lo.

## Licença

MIT. O FoxBin2Prg mantém sua própria licença e créditos em
`server/vendor/foxbin2prg/`.

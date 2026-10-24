# Product Requirement Document (PRD)

## Projeto: FoxPro IDE Web

## 1. Visão Geral do Produto

### 1.1 Objetivo

O **FoxPro IDE Web** é uma solução para visualização, edição, recompilação e preparação de código-fonte para LLMs a partir de projetos Visual FoxPro (`.pjx`/`.pjt`). A aplicação combina um **Editor Web (Web IDE)** moderno com um **Servidor Local (Local Bridge Service)** que empacota a ferramenta open-source [`FoxBin2Prg`](https://github.com/fdbozzo/foxbin2prg) para converter arquivos binários do FoxPro em texto editável e vice-versa sem dependências externas.

### 1.2 Problema que Resolve

Projetos legados em Visual FoxPro utilizam formatos binários para formulários, relatórios e bibliotecas de classe, dificultando a edição moderna, versionamento de código e, especialmente, a inclusão de código-fonte no contexto de modelos de IA (LLMs). O FoxPro IDE Web moderniza esse fluxo, permitindo edição ágil via navegador e extração estruturada para análise por IA.

---

## 2. Visão Geral da Arquitetura

O sistema é dividido em dois componentes principais:

```
+-------------------------------------------------------+
|                    NAVEGADOR WEB                      |
|  +-------------------------------------------------+  |
|  |             FoxPro Web IDE (Frontend)           |  |
|  | - Editor Monaco (Syntax Highlight + IntelliSense)|  |
|  | - Árvore de Arquivos / Sistema de Abas          |  |
|  | - Indicador de Status do Servidor (Online/Offline)|  |
|  | - Exportador Unificado / Particionado para LLM    |  |
|  | - Persistência LocalStorage                     |  |
|  +-------------------------------------------------+  |
+---------------------------^---------------------------+
                            | HTTP / WebSocket / REST (Porta Configurável)
+---------------------------v---------------------------+
|                   MÁQUINA LOCAL                       |
|  +-------------------------------------------------+  |
|  |            FoxPro Local Bridge Service          |  |
|  | - Servidor HTTP Localhost (Porta Configurável)  |  |
|  | - Ícone na Bandeja do Sistema (Systray)          |  |
|  | - Gerenciador / Visualizador de Logs             |  |
|  | - FoxBin2Prg Embutido (Zero Dependência)         |  |
|  | - Empacotamento/Compactação ZIP                 |  |
|  +-------------------------------------------------+  |
+-------------------------------------------------------+
```

---

## 3. Requisitos Funcionais

### 3.1 Servidor Local (Local Bridge Service)

* **RF-01 (Servidor Web Local e Porta Configurável):**
  * Iniciar servidor HTTP em `localhost` com porta configurável via arquivo de configuração ou interface simples (padrão: `8080`).

* **RF-02 (Empacotamento Autônomo - Zero Dependência):**
  * O executável do servidor local deve vir empacotado com o runtime necessário e os scripts compilados do `FoxBin2Prg` pré-configurados. O usuário não precisa instalar FoxPro ou VFP runtimes previamente.

* **RF-03 (Systray / Ícone de Bandeja e Logs):**
  * Ícone na bandeja do sistema operacional (Windows).
  * Menu de contexto no Systray:
    * *Status do Servidor* (Indicador Online/Offline e Porta ativa).
    * *Abrir Logs* (Abre janela ou arquivo com os logs de execução em tempo real).
    * *Configurações de Porta*.
    * *Iniciar / Parar Servidor*.
    * *Abrir IDE no Navegador*.
    * *Sair*.
  * Gravação de logs contínuos em arquivo rotativo (`app.log`) cobrindo requisições HTTP, execuções do FoxBin2Prg e eventuais erros.

* **RF-04 (Descompilação e Recompilação):**
  * Descompilar `.pjx` enviando os arquivos desestruturados para a Web IDE.
  * Recompilar arquivos texto modificados via `FoxBin2Prg` e devolver um pacote `.zip` compilado.

---

### 3.2 App Web (IDE Frontend)

#### A. Interface do Usuário (UI/Layout) & Monitoramento

* **RF-05 (Tema VS Code e Portas Configuráveis):**
  * Layout escuro (Dark Theme) limpo e minimalista.
  * Modal ou tela de configurações para definir o IP/Porta do Servidor Local ao qual a Web IDE deve se conectar.
  * Menu superior:
    * `Arquivo -> [ Importar Projeto (.pjx) | Salvar | Unificar p/ LLM | Compilar Modificados ]`

* **RF-06 (Indicador Status Servidor Local):**
  * Indicador visual dinâmico no cabeçalho/rodapé da IDE exibindo o estado da conexão com o Servidor Local:
    * 🟢 **Online** (Servidor ativo e respondendo).
    * 🔴 **Offline** (Servidor inativo, desconectado ou porta incorreta).

#### B. Gerenciamento e Edição de Arquivos

* **RF-07 (Estrutura Hierárquica de Arquivos):**
  * Exibição organizada:
    * 📌 **Programa Principal (Main PRG)**
    * 📁 **Programas (`.prg`)**
    * 📁 **Formulários (`.sc2` / `.scx`)**
    * 📁 **Classes (`.vc2` / `.vcx`)**
    * 📁 **Relatórios (`.fr2` / `.frx`)**
    * 📁 **Menus (`.mn2` / `.mnx`)**
    * 📁 **Outros Arquivos**

* **RF-08 (Editor Monaco com Syntax Highlighting e IntelliSense):**
  * Realce de sintaxe e autocomplete de comandos FoxPro.

* **RF-09 (Destaque de Modificados & LocalStorage):**
  * Marcador estilo Git (`M`) para arquivos alterados.
  * Persistência do estado atual da edição no `LocalStorage` para resiliência a recargas de página.

* **RF-12 (Preview Experimental de Formulários `.sc2`):**
  * Exibir uma visualização somente leitura do formulário ao lado do editor, com alternância **Código / Preview**.
  * Identificar o recurso como **Experimental** na interface.
  * Interpretar `DEFINE CLASS`, `ADD OBJECT`, objetos aninhados, páginas e colunas de grid.
  * Resolver classes customizadas a partir dos `.vc2` do workspace quando possível.
  * Não executar código VFP, métodos, queries ou data environment.
  * Exibir placeholder para OLE/ActiveX, classes externas não carregadas e imagens não disponíveis.
  * O preview não altera o texto do `.sc2`; o fluxo de salvar/compilar permanece inalterado.

#### C. Unificação de Código para Contexto LLM

* **RF-10 (Exportação Otimizada para LLM):**
  * Oferecer duas opções de exportação do código-fonte formatado para inclusão em prompts de IA:
    1. **Unificação Geral (Arquivo Único):** Agrupa todos os arquivos em um único `.txt`.
    2. **Unificação Particionada (Múltiplos Arquivos por Tipo):** Gera arquivos `.txt` separados por categoria (ex: `arquivo_main.txt`, `programas.txt`, `formularios.txt`, `classes.txt`, `relatorios.txt`).
  
* **RF-11 (Delimitadores Estruturados para LLM):**
  * Estruturação rigorosa com delimitadores explícitos para facilitar o parsing sintático por modelos de linguagem (GPT, Claude, Gemini).
  
  * *Exemplo da estrutura do arquivo unificado:*
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
  * Code for main program
  SET CENTURY ON
  DO form_login
  --- END_FILE: main.prg ---
  
  ================================================================================
  <<< END_CATEGORY: MAIN_PROGRAM >>>
  ================================================================================
  
  ================================================================================
  <<< START_CATEGORY: FORMS >>>
  ================================================================================
  
  --- BEGIN_FILE: cliente_form.sc2 | TYPE: FORM ---
  DEFINE CLASS form1 AS FORM
    Caption = "Cadastro de Clientes"
  ENDDEFINE
  --- END_FILE: cliente_form.sc2 ---
  
  ================================================================================
  <<< END_CATEGORY: FORMS >>>
  ================================================================================
  ```

---

## 4. Requisitos Não-Funcionais

* **RNF-01 (Autonomia de Instalação):** O usuário deve apenas rodar o executável do servidor local sem necessidade de instalar VFP, Python, Node ou dependências de terceiros.
* **RNF-02 (Segurança Local):** O servidor deve responder exclusivamente na interface de loopback (`127.0.0.1`).
* **RNF-03 (Tolerância a Falhas e Logs):** Caso ocorra falha na execução do `FoxBin2Prg`, o evento deve ser detalhado no log do Systray sem travar a aplicação web, exibindo mensagem amigável ao usuário.

---

## 5. Arquitetura de Comunicação (API REST)

| Método | Endpoint | Descrição |
| ----- | ----- | ----- |
| `GET` | `/api/status` | Polling da IDE para verificar status Online/Offline e obter versão |
| `POST` | `/api/project/import` | Envia caminho do `.pjx` para descompilação |
| `POST` | `/api/project/compile` | Envia arquivos editados para recompilação e geração do `.zip` |
| `GET` | `/api/logs` | Retorna as últimas linhas de log geradas pelo servidor local |

---

## 6. Critérios de Aceite

1. **Servidor Systray Autônomo:** Executável único que roda no Systray, possui menu de visualização de logs e já inclui o `FoxBin2Prg` funcional sem dependências externas.
2. **Conectividade e Monitoramento:** O App Web exibe o badge *Online/Offline* conforme o estado do servidor e permite alterar a porta de conexão.
3. **Exportação para LLM:** É possível exportar tanto em arquivo TXT único quanto particionado por tipo de arquivo, mantendo delimitadores claros e amigáveis para IA.
4. **Ciclo Completo de Compilação:** Descompilação do `.pjx`, edição na Web IDE com destaques sintáticos, e recompilação bem-sucedida em `.zip`.
5. **Preview Experimental:** Ao abrir um `.sc2`, o usuário consegue alternar entre **Código** e **Preview**, visualizando os controles comuns sem executar código VFP; formulários com classes externas, OLE ou imagens ausentes continuam abrindo com placeholders e avisos.
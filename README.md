# Catalog Explorer

Databricks App (construído com [AppKit](https://developers.databricks.com/docs/appkit/v0/) — React, TypeScript e Tailwind CSS) para navegar no Unity Catalog (catálogos → schemas → tabelas), visualizar e filtrar dados e exportar o resultado completo em CSV ou Excel.

Todas as operações rodam **em nome do usuário logado** (user authorization / on-behalf-of), então as permissões do Unity Catalog são respeitadas por usuário: cada pessoa só enxerga e exporta o que já tem acesso.

## Pré-requisitos

- Workspace Databricks com **Databricks Apps** habilitado e **user authorization** (OBO) disponível
- Um **SQL Warehouse Pro ou Serverless** no workspace
- [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html) (versão recente) autenticada no workspace (`databricks auth login --host https://<seu-workspace>`)
- Node.js v22+ e npm (apenas para desenvolvimento local)

## Como subir o app no seu workspace

### 1. Clonar o repositório

```bash
git clone https://github.com/bruna-robledo_data/catalog-explorer.git
cd catalog-explorer
```

### 2. Configurar o SQL Warehouse

O warehouse usado pelo app fica definido no código, no arquivo `app.yaml`. Troque o ID pelo ID de um warehouse do **seu** workspace:

```yaml
command: ['npm', 'run', 'start']
env:
  - name: DATABRICKS_WAREHOUSE_ID
    value: "<ID_DO_SEU_WAREHOUSE>"
```

Para descobrir o ID: **SQL Warehouses → (seu warehouse) → Connection details**, ou pela CLI:

```bash
databricks warehouses list --profile <SEU_PERFIL>
```

> O warehouse precisa ser do tipo **Pro** ou **Serverless** (o app usa a SQL Statement Execution API). Como as consultas rodam com a identidade do usuário, **cada usuário do app precisa ter permissão `CAN USE` nesse warehouse**.

### 3. Criar o app com os API scopes de user authorization

O app precisa dos seguintes **API scopes** de user authorization:

| Scope | Para quê |
|-------|----------|
| `sql` | **Obrigatório.** Executar consultas no SQL Warehouse em nome do usuário (listar catálogos/schemas/tabelas, prévia, contagem e exportação) |
| `catalog.catalogs:read` | Ler catálogos do Unity Catalog |
| `catalog.schemas:read` | Ler schemas do Unity Catalog |
| `catalog.tables:read` | Ler tabelas do Unity Catalog |

Os scopes `iam.access-control:read` e `iam.current-user:read` são adicionados automaticamente pela plataforma.

> ⚠️ Use o scope **`sql`** completo, e não o `sql:restricted-query`. O restrito bloqueia as chamadas GET da Statement Execution API usadas para paginar resultados e aguardar consultas longas. Com ele, a prévia funciona, mas a exportação de volumes grandes falha.

**Opção A — pela UI:**

1. **Compute → Apps → Create app → Create a custom app**, com o nome `catalog-explorer`
2. Na etapa **Configure → User authorization**, clique em **+ Add scope** e adicione `sql`, `catalog.catalogs:read`, `catalog.schemas:read` e `catalog.tables:read`
3. Conclua a criação

**Opção B — pela CLI:**

```bash
databricks apps create --profile <SEU_PERFIL> --json '{
  "name": "catalog-explorer",
  "description": "Navegar no Unity Catalog, filtrar e exportar tabelas em CSV/Excel",
  "user_api_scopes": [
    "sql",
    "catalog.catalogs:read",
    "catalog.schemas:read",
    "catalog.tables:read"
  ]
}'
```

> Para mudar os scopes depois de criado: **Apps → catalog-explorer → Edit → User authorization**. Reinicie o app depois de alterar.

### 4. Enviar o código e fazer o deploy

Envie os arquivos para uma pasta no workspace (o `sync` respeita o `.gitignore`, então `node_modules/` e `dist/` não são enviados):

```bash
databricks sync . /Workspace/Users/<seu.email>/catalog-explorer --profile <SEU_PERFIL>
```

Faça o deploy a partir dessa pasta:

```bash
databricks apps deploy catalog-explorer \
  --source-code-path /Workspace/Users/<seu.email>/catalog-explorer \
  --profile <SEU_PERFIL>
```

No deploy, a plataforma roda `npm install` e `npm run build` e depois inicia o app com o `command` do `app.yaml`.

> Também é possível fazer o deploy direto do GitHub: em **Apps → catalog-explorer → Deploy**, escolha **Git repository** e informe a URL deste repositório e a branch `main`.

### 5. Verificar

```bash
databricks apps get catalog-explorer --profile <SEU_PERFIL> -o json   # app_status.state deve ser RUNNING; o campo "url" é o endereço do app
databricks apps logs catalog-explorer --profile <SEU_PERFIL>          # logs (requer autenticação OAuth)
```

No primeiro acesso, cada usuário vê uma tela de consentimento pedindo os scopes acima. É preciso aceitar para usar o app.

### Permissões dos usuários

Como o app roda com a identidade de quem está logado, cada usuário precisa de:

- `CAN USE` no SQL Warehouse configurado no `app.yaml`
- `USE CATALOG` / `USE SCHEMA` nos catálogos e schemas que vai navegar
- `SELECT` nas tabelas que vai visualizar/exportar
- `CAN USE` no app (em **Apps → catalog-explorer → Permissions**)

## Desenvolvimento local

```bash
cp .env.example .env    # preencha DATABRICKS_HOST e DATABRICKS_WAREHOUSE_ID
npm install
npm run dev             # servidor com hot reload
```

Outros comandos:

```bash
npm run build       # gera dist/server.js e client/dist/
npm start           # roda o build de produção
npm run typecheck   # checagem de tipos
npm run lint        # lint (npm run lint:fix para corrigir)
npm run format      # prettier (npm run format:fix para corrigir)
npm test            # testes (vitest)
```

## Estrutura do projeto

```
client/                          # Frontend React
  src/App.tsx                    # Tela principal
  src/api.ts                     # Chamadas ao backend
  public/                        # Assets estáticos
server/                          # Backend Express (AppKit)
  server.ts                      # Ponto de entrada
  catalog-explorer-plugin.ts     # Plugin: navegação no UC, prévia, filtros e exportação
app.yaml                         # Configuração do app (comando e warehouse)
appkit.plugins.json              # Manifesto de plugins do AppKit
.env.example                     # Exemplo de variáveis para desenvolvimento local
```

## Stack

- **Backend**: Node.js, Express, AppKit SDK
- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Componentes de UI**: Radix UI, shadcn/ui
- **Databricks**: SQL Statement Execution API, Unity Catalog, user authorization (OBO)

## Aviso

> **Este projeto não é um produto oficial da Databricks e não tem suporte da Databricks.** É um exemplo fornecido "como está" (*as is*), sem garantias de qualquer tipo, expressas ou implícitas, nem SLA. Problemas com este código não devem ser abertos como tickets de suporte da Databricks. Revise, teste e valide o código antes de usá-lo em produção; o uso é de responsabilidade de quem o implanta.

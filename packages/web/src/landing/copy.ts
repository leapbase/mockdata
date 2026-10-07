// Landing page text in each language. Code, sample rows and URLs live in content.ts and are not translated.
// Every claim describes something the project really does (see README.md); keep the three languages saying the same thing.
import type { Locale } from "../i18n";
import { MCP_URL, SOURCE_URL } from "./content";

type Item = { title: string; body: string };
export type LandingCopy = {
  nav: { how: string; features: string; useCases: string; faq: string; docs: string; sections: string };
  cta: { getStarted: string; signIn: string; openWorkspace: string };
  hero: { pill: string; title: string; titleAccent: string; lead: string; seeSchema: string; facts: string[]; factsLabel: string; demoLabel: string; demoCaption: string };
  how: { eyebrow: string; title: string; intro: string; steps: Item[] };
  features: { eyebrow: string; title: string; intro: string; items: Item[] };
  diagram: { eyebrow: string; title: string; intro: string; caption: string; loading: string };
  snippets: { eyebrow: string; title: string; intro: string; tabsLabel: string; schema: string; cli: string; mcp: string };
  useCases: { eyebrow: string; title: string; items: Item[] };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  closing: { title: string; body: string };
  footer: { tagline: string; workspace: string; source: string };
};

const en: LandingCopy = {
  nav: { how: "How it works", features: "Features", useCases: "Use cases", faq: "FAQ", docs: "Docs", sections: "Page sections" },
  cta: { getStarted: "Get started", signIn: "Sign in", openWorkspace: "Open workspace" },
  hero: {
    pill: "CLI · web UI · MCP server",
    title: "Realistic, related test data",
    titleAccent: "from one schema",
    lead: "Deterministic generators handle keys, numbers and dates, every foreign key points at a real row, and an LLM writes only the free-text columns you choose.",
    seeSchema: "See the schema",
    facts: ["Seeded, reproducible output", "Constraints re-validated", "Runs locally"],
    factsLabel: "Highlights",
    demoLabel: "A schema and the rows it generates",
    demoCaption: "first 5 of 100 rows · seed 42",
  },
  how: {
    eyebrow: "How it works", title: "From schema to dataset in three steps", intro: "Describe the tables once; mockdata works out the order, the keys and the rules.",
    steps: [
      { title: "Define or infer a schema", body: "Write a short YAML schema, or infer one from a SQLite, Postgres or MySQL catalog, an OpenAPI or JSON Schema file, or sample CSV/JSON rows." },
      { title: "Generate", body: "Parents are generated before children, so every foreign key resolves. Constraints hold by construction and are re-checked before anything is returned." },
      { title: "Export", body: "Download JSON, NDJSON or CSV (one file per table, or a zip), or copy CREATE TABLE statements for PostgreSQL, MySQL or SQLite." },
    ],
  },
  diagram: {
    eyebrow: "Relationships", title: "See how your tables connect",
    intro: "Every schema gets a live diagram in the workspace: each arrow is a foreign key, from the column that holds it to the row it points at.",
    caption: "examples/supply-chain.yaml · nine tables · drag to pan, use the buttons to zoom",
    loading: "Loading the diagram…",
  },
  features: {
    eyebrow: "Features", title: "More than random rows", intro: "Constraints are enforced by code and checked again, not left to a prompt.",
    items: [
      { title: "Referential integrity", body: "Foreign keys always point at real rows. Skew children with a zipf distribution, cap them with maxPerParent, or make a key one-to-one." },
      { title: "Cross-column rules", body: "A ship date is never before the order date. `after` reads the same row or a parent row through a foreign key, and `within` caps the gap." },
      { title: "LLM text, only where it helps", body: "Mark a column `llm` and a model writes it (Anthropic, OpenAI, Ollama or any OpenAI-compatible server), seeing the row and its parent rows." },
      { title: "Infer from what you have", body: "Read a database catalog, an API spec or sample files. Only metadata is read from databases; anything guessed is reported as a warning." },
      { title: "Reproducible by seed", body: "Keys, numbers, dates and enums come from seeded generators. Same schema and seed, same data, in CI and on every laptop." },
      { title: "Hosted MCP for AI agents", body: `Point Claude, Cursor or any MCP client at \`${MCP_URL}\` with an API key, and agents can validate, infer and generate data in your workspace.` },
    ],
  },
  snippets: { eyebrow: "Use it your way", title: "One schema, three ways in", intro: "Edit and preview in the web UI, script it with the CLI, or connect an agent to the hosted MCP endpoint.", tabsLabel: "Examples", schema: "Schema (YAML)", cli: "CLI", mcp: "MCP" },
  useCases: {
    eyebrow: "Use cases", title: "Where it fits",
    items: [
      { title: "Frontend before the backend", body: "Build screens against related, realistic records on day one, before an API exists." },
      { title: "QA and CI fixtures", body: "Seeded datasets give tests the same rows on every run, with edge cases such as nulls and skew you choose." },
      { title: "Demo environments", body: "Fill a demo with believable customers, orders and reviews without copying anyone's real data." },
      { title: "AI agent sandboxes", body: "Let a coding agent create and regenerate test data through the hosted MCP endpoint, inside your own workspace." },
      { title: "Stand-ins for production", body: "Infer the shape of a production schema and generate look-alike data: shape is copied, rows never are." },
    ],
  },
  faq: {
    eyebrow: "FAQ", title: "Questions, answered",
    items: [
      { q: "Is it free and open source?", a: `Yes. mockdata.com is free to use, with the same per-account limits on rows and model-written text that keep it fair for everyone. The code is open source under the AGPL-3.0-or-later at ${SOURCE_URL}, so you can also run it yourself.` },
      { q: "Is the output deterministic?", a: "Yes for everything except model-written text: keys, numbers, dates, enums and faker values come from a seeded generator, so the same schema and seed give the same data. Text written by an LLM is not reproducible by seed." },
      { q: "Do I need an LLM?", a: "No. A model is only used for columns marked llm. Configure Anthropic, OpenAI, Ollama or an OpenAI-compatible server in .env when you want it." },
      { q: "Does infer read my database rows?", a: "No. Database inference reads catalog metadata only (tables, columns, keys), in a read-only session. Sample files are read to learn shape, but rows are never copied; low-cardinality columns can copy their observed values as enums, which you can turn off." },
      { q: "How do I connect an AI agent?", a: `Sign in, create a key under API keys in the account menu, and add ${MCP_URL} to your MCP client with the header Authorization: Bearer <key>. Agents work in your own workspace, with the same limits as the web app; revoke a key at any time.` },
      { q: "Can it run entirely locally?", a: "Yes. The CLI, web UI and MCP server (stdio or local HTTP) also run on your machine, and with Ollama even the text generation stays local." },
      { q: "Which formats can I export?", a: "JSON, NDJSON and CSV, written into your folder or downloaded as a zip, plus CREATE TABLE statements for PostgreSQL, MySQL and SQLite from the diagram." },
      { q: "Is it safe to open on a network?", a: "The servers listen on localhost by default. You can open them to private address ranges with a shared token, or run accounts mode behind an https reverse proxy. Traffic from the server itself is plain http." },
    ],
  },
  closing: { title: "Stop hand-writing fixtures.", body: "Describe your tables once and generate as much related data as you need." },
  footer: { tagline: "mockdata · schema to synthetic data", workspace: "Workspace", source: "Source on GitHub" },
};

const es: LandingCopy = {
  nav: { how: "Cómo funciona", features: "Funciones", useCases: "Casos de uso", faq: "Preguntas", docs: "Documentación", sections: "Secciones de la página" },
  cta: { getStarted: "Empezar", signIn: "Iniciar sesión", openWorkspace: "Abrir la app" },
  hero: {
    pill: "CLI · interfaz web · servidor MCP",
    title: "Datos de prueba realistas y relacionados",
    titleAccent: "a partir de un solo esquema",
    lead: "Generadores deterministas se encargan de claves, números y fechas, cada clave foránea apunta a una fila real y un LLM escribe solo las columnas de texto libre que tú elijas.",
    seeSchema: "Ver el esquema",
    facts: ["Resultados reproducibles con semilla", "Restricciones validadas de nuevo", "Funciona en local"],
    factsLabel: "Puntos clave",
    demoLabel: "Un esquema y las filas que genera",
    demoCaption: "primeras 5 de 100 filas · semilla 42",
  },
  how: {
    eyebrow: "Cómo funciona", title: "Del esquema al conjunto de datos en tres pasos", intro: "Describe las tablas una vez; mockdata se encarga del orden, las claves y las reglas.",
    steps: [
      { title: "Define o infiere un esquema", body: "Escribe un esquema YAML breve o infiérelo de un catálogo SQLite, Postgres o MySQL, de un archivo OpenAPI o JSON Schema, o de filas de ejemplo en CSV/JSON." },
      { title: "Genera", body: "Las tablas padre se generan antes que las hijas, así que toda clave foránea se resuelve. Las restricciones se cumplen por construcción y se vuelven a comprobar antes de devolver nada." },
      { title: "Exporta", body: "Descarga JSON, NDJSON o CSV (un archivo por tabla, o un zip), o copia sentencias CREATE TABLE para PostgreSQL, MySQL o SQLite." },
    ],
  },
  diagram: {
    eyebrow: "Relaciones", title: "Mira cómo se conectan tus tablas",
    intro: "Cada esquema tiene un diagrama en vivo en el espacio de trabajo: cada flecha es una clave foránea, desde la columna que la contiene hasta la fila a la que apunta.",
    caption: "examples/supply-chain.yaml · nueve tablas · arrastra para desplazarte, usa los botones para ampliar",
    loading: "Cargando el diagrama…",
  },
  features: {
    eyebrow: "Funciones", title: "Más que filas aleatorias", intro: "Las restricciones se aplican con código y se vuelven a comprobar; no se dejan en manos de un prompt.",
    items: [
      { title: "Integridad referencial", body: "Las claves foráneas siempre apuntan a filas reales. Sesga los hijos con una distribución zipf, limítalos con maxPerParent o haz que una clave sea uno a uno." },
      { title: "Reglas entre columnas", body: "Una fecha de envío nunca es anterior a la del pedido. `after` lee la misma fila o una fila padre a través de una clave foránea, y `within` limita el intervalo." },
      { title: "Texto de LLM, solo donde ayuda", body: "Marca una columna con `llm` y un modelo la escribe (Anthropic, OpenAI, Ollama o cualquier servidor compatible con OpenAI), viendo la fila y sus filas padre." },
      { title: "Infiere a partir de lo que tienes", body: "Lee el catálogo de una base de datos, una especificación de API o archivos de ejemplo. De las bases de datos solo se leen metadatos; todo lo que se deduce se avisa." },
      { title: "Reproducible con semilla", body: "Claves, números, fechas y enums salen de generadores con semilla. Mismo esquema y semilla, mismos datos, en CI y en cada portátil." },
      { title: "MCP alojado para agentes de IA", body: `Conecta Claude, Cursor o cualquier cliente MCP a \`${MCP_URL}\` con una clave de API, y los agentes podrán validar, inferir y generar datos en tu espacio de trabajo.` },
    ],
  },
  snippets: { eyebrow: "Úsalo a tu manera", title: "Un esquema, tres formas de usarlo", intro: "Edita y previsualiza en la interfaz web, automatiza con la CLI o conecta un agente al endpoint MCP alojado.", tabsLabel: "Ejemplos", schema: "Esquema (YAML)", cli: "CLI", mcp: "MCP" },
  useCases: {
    eyebrow: "Casos de uso", title: "Dónde encaja",
    items: [
      { title: "Frontend antes que el backend", body: "Construye pantallas con registros realistas y relacionados desde el primer día, antes de que exista una API." },
      { title: "Datos fijos para QA y CI", body: "Los conjuntos con semilla dan a las pruebas las mismas filas en cada ejecución, con los casos límite que elijas, como nulos y sesgo." },
      { title: "Entornos de demostración", body: "Llena una demo con clientes, pedidos y reseñas creíbles sin copiar datos reales de nadie." },
      { title: "Entornos para agentes de IA", body: "Deja que un agente de programación cree y regenere datos de prueba a través del endpoint MCP alojado, dentro de tu propio espacio de trabajo." },
      { title: "Sustitutos de producción", body: "Infiere la forma de un esquema de producción y genera datos parecidos: se copia la forma, nunca las filas." },
    ],
  },
  faq: {
    eyebrow: "Preguntas", title: "Preguntas frecuentes",
    items: [
      { q: "¿Es gratuito y de código abierto?", a: `Sí. mockdata.com es gratuito, con los mismos límites por cuenta de filas y de texto escrito por modelos para que sea justo para todos. El código es abierto bajo la licencia AGPL-3.0-or-later en ${SOURCE_URL}, así que también puedes ejecutarlo tú mismo.` },
      { q: "¿El resultado es determinista?", a: "Sí, salvo el texto escrito por modelos: claves, números, fechas, enums y valores de faker salen de un generador con semilla, así que el mismo esquema y la misma semilla dan los mismos datos. El texto de un LLM no se reproduce con la semilla." },
      { q: "¿Necesito un LLM?", a: "No. Solo se usa un modelo en las columnas marcadas con llm. Configura Anthropic, OpenAI, Ollama o un servidor compatible con OpenAI en .env cuando lo necesites." },
      { q: "¿Infer lee las filas de mi base de datos?", a: "No. La inferencia desde una base de datos solo lee metadatos del catálogo (tablas, columnas, claves), en una sesión de solo lectura. Los archivos de ejemplo se leen para aprender su forma, pero las filas nunca se copian; las columnas con pocos valores distintos pueden copiar los valores observados como enums, algo que puedes desactivar." },
      { q: "¿Cómo conecto un agente de IA?", a: `Inicia sesión, crea una clave en Claves de API dentro del menú de la cuenta y añade ${MCP_URL} a tu cliente MCP con la cabecera Authorization: Bearer <clave>. Los agentes trabajan en tu propio espacio, con los mismos límites que la aplicación web; puedes revocar una clave en cualquier momento.` },
      { q: "¿Puede funcionar totalmente en local?", a: "Sí. La CLI, la interfaz web y el servidor MCP (stdio o HTTP local) también funcionan en tu equipo, y con Ollama incluso la generación de texto se queda en local." },
      { q: "¿Qué formatos puedo exportar?", a: "JSON, NDJSON y CSV, guardados en tu carpeta o descargados como zip, además de sentencias CREATE TABLE para PostgreSQL, MySQL y SQLite desde el diagrama." },
      { q: "¿Es seguro abrirlo a una red?", a: "Los servidores escuchan en localhost por defecto. Puedes abrirlos a rangos de direcciones privadas con un token compartido, o usar el modo de cuentas detrás de un proxy inverso con https. El tráfico del propio servidor es http sin cifrar." },
    ],
  },
  closing: { title: "Deja de escribir datos de prueba a mano.", body: "Describe tus tablas una vez y genera todos los datos relacionados que necesites." },
  footer: { tagline: "mockdata · del esquema a datos sintéticos", workspace: "Espacio de trabajo", source: "Código en GitHub" },
};

const zh: LandingCopy = {
  nav: { how: "工作原理", features: "功能", useCases: "使用场景", faq: "常见问题", docs: "文档", sections: "页面导航" },
  cta: { getStarted: "开始使用", signIn: "登录", openWorkspace: "打开工作区" },
  hero: {
    pill: "命令行 · 网页界面 · MCP 服务器",
    title: "真实且相互关联的测试数据",
    titleAccent: "只需一份 Schema",
    lead: "确定性生成器负责主键、数值和日期，每个外键都指向真实存在的行，LLM 只填写你指定的自由文本列。",
    seeSchema: "查看 Schema",
    facts: ["固定种子，结果可复现", "约束会再次校验", "可在本地运行"],
    factsLabel: "亮点",
    demoLabel: "一份 Schema 及其生成的数据行",
    demoCaption: "100 行中的前 5 行 · 种子 42",
  },
  how: {
    eyebrow: "工作原理", title: "三步从 Schema 到数据集", intro: "只需描述一次表结构，mockdata 会自动处理生成顺序、主外键和规则。",
    steps: [
      { title: "编写或推断 Schema", body: "编写一份简短的 YAML Schema，或从 SQLite、Postgres、MySQL 的目录信息、OpenAPI 或 JSON Schema 文件、CSV/JSON 样例数据中推断。" },
      { title: "生成", body: "先生成父表再生成子表，因此每个外键都能对应上。约束在生成时即被满足，并在返回前再次校验。" },
      { title: "导出", body: "下载 JSON、NDJSON 或 CSV（每张表一个文件，或打包为 zip），也可以复制适用于 PostgreSQL、MySQL 或 SQLite 的 CREATE TABLE 语句。" },
    ],
  },
  diagram: {
    eyebrow: "关系", title: "一眼看清表之间的关系",
    intro: "每份 Schema 在工作区中都有一张实时关系图：每条箭头代表一个外键，从存放外键的列指向它所引用的行。",
    caption: "examples/supply-chain.yaml · 九张表 · 拖动可平移，用按钮缩放",
    loading: "正在加载关系图…",
  },
  features: {
    eyebrow: "功能", title: "不只是随机数据", intro: "约束由代码执行并再次校验，而不是交给提示词碰运气。",
    items: [
      { title: "参照完整性", body: "外键始终指向真实存在的行。可以用 zipf 分布让子行集中、用 maxPerParent 限制数量，或把外键设为一对一。" },
      { title: "跨列规则", body: "发货日期绝不会早于下单日期。`after` 可以读取同一行或通过外键读取父行，`within` 限制间隔天数。" },
      { title: "LLM 文本，只用在需要的地方", body: "把某列标记为 `llm`，由模型来写（Anthropic、OpenAI、Ollama 或任何兼容 OpenAI 的服务），模型能看到这一行及其父行。" },
      { title: "从现有资源推断", body: "读取数据库目录、API 规范或样例文件。从数据库只读取元数据；任何推测出的内容都会以警告列出。" },
      { title: "种子可复现", body: "主键、数值、日期和枚举都来自带种子的生成器。相同的 Schema 和种子，在 CI 和每台电脑上都得到相同的数据。" },
      { title: "为 AI 智能体托管的 MCP", body: `用 API 密钥把 Claude、Cursor 或任何 MCP 客户端连接到 \`${MCP_URL}\`，智能体就能在你的工作区里校验、推断和生成数据。` },
    ],
  },
  snippets: { eyebrow: "按你的方式使用", title: "一份 Schema，三种用法", intro: "在网页界面中编辑和预览，用命令行写脚本，或把智能体连接到托管的 MCP 端点。", tabsLabel: "示例", schema: "Schema（YAML）", cli: "命令行", mcp: "MCP" },
  useCases: {
    eyebrow: "使用场景", title: "适用场景",
    items: [
      { title: "后端未就绪时开发前端", body: "在 API 出现之前，第一天就能用真实、相互关联的记录搭建页面。" },
      { title: "QA 与 CI 测试数据", body: "带种子的数据集让每次测试都得到相同的数据行，并包含你选择的边界情况，例如空值和数据倾斜。" },
      { title: "演示环境", body: "用可信的客户、订单和评论填充演示环境，而不必复制任何人的真实数据。" },
      { title: "AI 智能体沙盒", body: "让编程智能体通过托管的 MCP 端点，在你自己的工作区中创建并重新生成测试数据。" },
      { title: "生产数据的替身", body: "推断生产 Schema 的结构并生成相似的数据：只复制结构，绝不复制数据行。" },
    ],
  },
  faq: {
    eyebrow: "常见问题", title: "问题解答",
    items: [
      { q: "它是免费且开源的吗？", a: `是的。mockdata.com 可免费使用，每个账号在数据行数和模型生成文本上有相同的限额，以保证对所有人公平。代码以 AGPL-3.0-or-later 许可证开源，地址是 ${SOURCE_URL}，你也可以自行部署。` },
      { q: "输出是确定性的吗？", a: "除模型生成的文本外都是：主键、数值、日期、枚举和 faker 值都来自带种子的生成器，所以相同的 Schema 和种子会得到相同的数据。LLM 写的文本无法通过种子复现。" },
      { q: "我需要 LLM 吗？", a: "不需要。只有标记为 llm 的列才会调用模型。需要时在 .env 中配置 Anthropic、OpenAI、Ollama 或兼容 OpenAI 的服务即可。" },
      { q: "infer 会读取我数据库里的数据行吗？", a: "不会。从数据库推断时只在只读会话中读取目录元数据（表、列、键）。样例文件会被读取以了解结构，但数据行绝不会被复制；取值较少的列可以把观察到的值复制为枚举，这一点可以关闭。" },
      { q: "如何连接 AI 智能体？", a: `登录后在账号菜单的 API 密钥中创建一个密钥，然后在 MCP 客户端中添加 ${MCP_URL}，并带上请求头 Authorization: Bearer <密钥>。智能体在你自己的工作区中工作，限额与网页版相同；密钥可随时撤销。` },
      { q: "可以完全在本地运行吗？", a: "可以。命令行、网页界面和 MCP 服务器（stdio 或本地 HTTP）都能在你的电脑上运行，配合 Ollama 时连文本生成也留在本地。" },
      { q: "可以导出哪些格式？", a: "JSON、NDJSON 和 CSV，可以写入你的文件夹或打包成 zip 下载；还可以从关系图中获取适用于 PostgreSQL、MySQL 和 SQLite 的 CREATE TABLE 语句。" },
      { q: "开放到网络上安全吗？", a: "服务器默认只监听 localhost。你可以借助共享令牌向私有地址段开放，或在 https 反向代理之后运行账号模式。服务器自身的流量是未加密的 http。" },
    ],
  },
  closing: { title: "别再手写测试数据了。", body: "只需描述一次表结构，就能生成所需的任意数量的关联数据。" },
  footer: { tagline: "mockdata · 从 Schema 生成合成数据", workspace: "工作区", source: "GitHub 源代码" },
};

export const LANDING_COPY: Record<Locale, LandingCopy> = { en, es, zh };

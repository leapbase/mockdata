import type { LandingCopy, Locale } from "@mockdata/web";
import { SOURCE_URL } from "@mockdata/web";

/** The hosted MCP endpoint (Streamable HTTP; API key from the account menu). */
export const MCP_URL = "https://mockdata.com/mcp";

/** Connecting Claude Code to the hosted MCP endpoint (API key from the account menu). */
export const MCP_COMMAND = `claude mcp add --transport http mockdata ${MCP_URL} \\
  --header "Authorization: Bearer <your API key>"`;

/** The hosted wording for each locale: what mockdata.com says where the open page describes the local MCP server. */
const HOSTED: Record<Locale, {
  feature: { title: string; body: string };
  snippetsIntro: string;
  mcpIntro: string;
  mcpPoint: string;
  mcpMore: string;
  useCase: { title: string; body: string };
  faqFree: { q: string; a: string };
  faqAgent: { q: string; a: string };
  faqNetwork: { q: string; a: string };
}> = {
  en: {
    feature: { title: "Hosted MCP for AI agents", body: `Point Claude, Cursor or any MCP client at \`${MCP_URL}\` with an API key, and agents can validate, infer and generate data in your workspace.` },
    snippetsIntro: "Edit and preview in the web UI, script it with the CLI, or connect an agent to the hosted MCP endpoint.",
    mcpIntro: "Give Claude, Cursor or any MCP client an API key, and it can write schemas, infer them and generate data for you.",
    mcpPoint: "Agents work in your own folder, with the same limits as the web workspace.",
    mcpMore: "MCP on the web",
    useCase: { title: "AI agent sandboxes", body: "Let a coding agent create and regenerate test data through the hosted MCP endpoint, inside your own workspace." },
    faqFree: { q: "Is it free and open source?", a: `Yes. mockdata.com is free to use, with the same per-account limits on rows and model-written text that keep it fair for everyone. The code is open source under the AGPL-3.0-or-later at ${SOURCE_URL}, so you can also run it yourself.` },
    faqAgent: { q: "How do I connect an AI agent?", a: `Sign in, create a key under API keys in the account menu, and add ${MCP_URL} to your MCP client with the header Authorization: Bearer <key>. Agents work in your own workspace, with the same limits as the web app; revoke a key at any time.` },
    faqNetwork: { q: "Is it safe to open on a network?", a: "The servers listen on localhost by default. You can open them to private address ranges with a shared token, or run accounts mode behind an https reverse proxy. Traffic from the server itself is plain http." },
  },
  es: {
    feature: { title: "MCP alojado para agentes de IA", body: `Conecta Claude, Cursor o cualquier cliente MCP a \`${MCP_URL}\` con una clave de API, y los agentes podrán validar, inferir y generar datos en tu espacio de trabajo.` },
    snippetsIntro: "Edita y previsualiza en la interfaz web, automatiza con la CLI o conecta un agente al endpoint MCP alojado.",
    mcpIntro: "Dale una clave de API a Claude, Cursor o cualquier cliente MCP, y podrá escribir esquemas, inferirlos y generar datos por ti.",
    mcpPoint: "Los agentes trabajan en tu propia carpeta, con los mismos límites que el espacio de trabajo web.",
    mcpMore: "MCP en la web",
    useCase: { title: "Entornos para agentes de IA", body: "Deja que un agente de programación cree y regenere datos de prueba a través del endpoint MCP alojado, dentro de tu propio espacio de trabajo." },
    faqFree: { q: "¿Es gratuito y de código abierto?", a: `Sí. mockdata.com es gratuito, con los mismos límites por cuenta de filas y de texto escrito por modelos para que sea justo para todos. El código es abierto bajo la licencia AGPL-3.0-or-later en ${SOURCE_URL}, así que también puedes ejecutarlo tú mismo.` },
    faqAgent: { q: "¿Cómo conecto un agente de IA?", a: `Inicia sesión, crea una clave en Claves de API dentro del menú de la cuenta y añade ${MCP_URL} a tu cliente MCP con la cabecera Authorization: Bearer <clave>. Los agentes trabajan en tu propio espacio, con los mismos límites que la aplicación web; puedes revocar una clave en cualquier momento.` },
    faqNetwork: { q: "¿Es seguro abrirlo a una red?", a: "Los servidores escuchan en localhost por defecto. Puedes abrirlos a rangos de direcciones privadas con un token compartido, o usar el modo de cuentas detrás de un proxy inverso con https. El tráfico del propio servidor es http sin cifrar." },
  },
  zh: {
    feature: { title: "为 AI 智能体托管的 MCP", body: `用 API 密钥把 Claude、Cursor 或任何 MCP 客户端连接到 \`${MCP_URL}\`，智能体就能在你的工作区里校验、推断和生成数据。` },
    snippetsIntro: "在网页界面中编辑和预览，用命令行写脚本，或把智能体连接到托管的 MCP 端点。",
    mcpIntro: "给 Claude、Cursor 或任何 MCP 客户端一个 API 密钥，它就能替你编写 Schema、推断 Schema 并生成数据。",
    mcpPoint: "智能体在你自己的文件夹中工作，限额与网页工作区相同。",
    mcpMore: "网页版 MCP",
    useCase: { title: "AI 智能体沙盒", body: "让编程智能体通过托管的 MCP 端点，在你自己的工作区中创建并重新生成测试数据。" },
    faqFree: { q: "它是免费且开源的吗？", a: `是的。mockdata.com 可免费使用，每个账号在数据行数和模型生成文本上有相同的限额，以保证对所有人公平。代码以 AGPL-3.0-or-later 许可证开源，地址是 ${SOURCE_URL}，你也可以自行部署。` },
    faqAgent: { q: "如何连接 AI 智能体？", a: `登录后在账号菜单的 API 密钥中创建一个密钥，然后在 MCP 客户端中添加 ${MCP_URL}，并带上请求头 Authorization: Bearer <密钥>。智能体在你自己的工作区中工作，限额与网页版相同；密钥可随时撤销。` },
    faqNetwork: { q: "开放到网络上安全吗？", a: "服务器默认只监听 localhost。你可以借助共享令牌向私有地址段开放，或在 https 反向代理之后运行账号模式。服务器自身的流量是未加密的 http。" },
  },
};

const at = <T,>(list: T[], i: number, value: T): T[] => list.map((x, j) => (j === i ? value : x));

/** The landing copy with mockdata.com's hosted wording swapped in for the open page's local-MCP wording. */
export function hostedLandingCopy(base: LandingCopy, locale: Locale): LandingCopy {
  const h = HOSTED[locale];
  return {
    ...base,
    features: { ...base.features, items: at(base.features.items, 5, h.feature) },
    snippets: { ...base.snippets, intro: h.snippetsIntro },
    ai: { ...base.ai, mcpIntro: h.mcpIntro, mcpPoints: at(base.ai.mcpPoints, 0, h.mcpPoint), mcpMore: h.mcpMore, mcpCommand: MCP_COMMAND, mcpHref: "/docs/mcp" },
    useCases: { ...base.useCases, items: at(base.useCases.items, 3, h.useCase) },
    faq: { ...base.faq, items: at(at(at(base.faq.items, 0, h.faqFree), 4, h.faqAgent), 7, h.faqNetwork) },
  };
}

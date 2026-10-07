import type { Locale } from "../i18n";

/** The docs page's own labels; the page text itself comes from content.ts and the i18n dictionaries. */
export type DocsStrings = {
  home: string; docs: string; github: string; openWorkspace: string; site: string;
  search: string; searchResults: string; noResults: (q: string) => string;
  pages: string; overview: string; onThisPage: string; pager: string; previous: string; next: string;
  menu: string; closeMenu: string; copy: string; copied: string; copyCode: string; copyNamed: (name: string) => string;
  footer: string; edit: string; notFound: string; notFoundBody: string; notFoundHome: string; notFoundSearch: string;
  titleSuffix: string; translated?: string;
};

export const DOCS_STRINGS: Record<Locale, DocsStrings> = {
  en: {
    home: "Home", docs: "Docs", github: "GitHub", openWorkspace: "Open workspace", site: "Site",
    search: "Search docs…", searchResults: "Search results", noResults: (q) => `No results for “${q}”`,
    pages: "Documentation pages", overview: "Overview", onThisPage: "On this page", pager: "Previous and next page", previous: "Previous", next: "Next",
    menu: "Menu", closeMenu: "Close menu", copy: "Copy", copied: "Copied", copyCode: "Copy code", copyNamed: (n) => `Copy ${n}`,
    footer: "mockdata · open source under AGPL-3.0", edit: "Edit this page on GitHub",
    notFound: "Page not found", notFoundBody: "There is no documentation page at", notFoundHome: "Go to the documentation home", notFoundSearch: "or search above.",
    titleSuffix: "mockdata docs",
  },
  es: {
    home: "Inicio", docs: "Documentación", github: "GitHub", openWorkspace: "Abrir la app", site: "Sitio",
    search: "Buscar…", searchResults: "Resultados de búsqueda", noResults: (q) => `No hay resultados para «${q}»`,
    pages: "Páginas de la documentación", overview: "Introducción", onThisPage: "En esta página", pager: "Página anterior y siguiente", previous: "Anterior", next: "Siguiente",
    menu: "Menú", closeMenu: "Cerrar menú", copy: "Copiar", copied: "Copiado", copyCode: "Copiar código", copyNamed: (n) => `Copiar ${n}`,
    footer: "mockdata · código abierto bajo AGPL-3.0", edit: "Editar esta página en GitHub",
    notFound: "Página no encontrada", notFoundBody: "No hay ninguna página de documentación en", notFoundHome: "Ir al inicio de la documentación", notFoundSearch: "o busca arriba.",
    titleSuffix: "documentación de mockdata",
    translated: "Traducción del original en inglés. Los nombres de botones y menús del espacio de trabajo aparecen en inglés, tal como se ven en la aplicación.",
  },
  zh: {
    home: "首页", docs: "文档", github: "GitHub", openWorkspace: "打开工作区", site: "站点",
    search: "搜索文档…", searchResults: "搜索结果", noResults: (q) => `没有找到“${q}”的结果`,
    pages: "文档页面", overview: "概览", onThisPage: "本页内容", pager: "上一页和下一页", previous: "上一页", next: "下一页",
    menu: "菜单", closeMenu: "关闭菜单", copy: "复制", copied: "已复制", copyCode: "复制代码", copyNamed: (n) => `复制 ${n}`,
    footer: "mockdata · 以 AGPL-3.0 开源", edit: "在 GitHub 上编辑此页",
    notFound: "页面不存在", notFoundBody: "以下地址没有文档页面：", notFoundHome: "前往文档首页", notFoundSearch: "或在上方搜索。",
    titleSuffix: "mockdata 文档",
    translated: "本页译自英文原文。工作区中的按钮和菜单名称保留英文，与应用中显示的一致。",
  },
};

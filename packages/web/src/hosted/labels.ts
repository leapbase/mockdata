import type { Cta, Locale } from "@mockdata/web";

/** Call-to-action labels for a signed-out visitor, where accounts are on. */
export const SIGN_IN: Record<Locale, Pick<Cta, "primary" | "nav">> = {
  en: { primary: "Get started", nav: "Sign in" },
  es: { primary: "Empezar", nav: "Iniciar sesión" },
  zh: { primary: "开始使用", nav: "登录" },
};

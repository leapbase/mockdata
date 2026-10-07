import AuthGate, { useAccountCta } from "./AuthGate";
import { mountApp } from "./mount";

mountApp({ gate: AuthGate, useLandingCta: useAccountCta });

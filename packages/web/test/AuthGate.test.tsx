// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthGate from "../src/AuthGate";
import { setOnUnauthorized } from "../src/api";
import { stubApi } from "./stub";

const USER = { id: 1, email: "ann@example.com", displayName: "ann", avatarUrl: null };
const ME_OFF = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };
const me = (user: typeof USER | null, auth: Partial<{ googleConfigured: boolean; emailEnabled: boolean }> = {}) => ({
  user,
  auth: { accountsEnabled: true, googleConfigured: false, emailEnabled: true, ...auth },
});
const fail = (status: number, message: string, code?: string) => new Response(JSON.stringify({ error: { message, code } }), { status });
const PASSWORD = "Sup3r$ecretPassw0rd";

beforeEach(() => window.history.replaceState({}, "", "/"));
afterEach(() => {
  cleanup();
  setOnUnauthorized(undefined);
  vi.unstubAllGlobals();
});

function app() {
  return (
    <AuthGate>
      <div>the app</div>
    </AuthGate>
  );
}

describe("AuthGate", () => {
  it("shows the app straight away when accounts are off (local mode is unchanged)", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(app());
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("falls back to the app if the server has no auth route at all (an older server)", async () => {
    stubApi({}); // every route 404s
    render(app());
    expect(await screen.findByText("the app")).toBeTruthy();
  });

  it("asks for sign-in when accounts are on, refuses a bad password without revealing why, then shows the app", async () => {
    let signedIn = false;
    stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "POST /api/auth/login": (b) => {
        if (b.password !== PASSWORD) return fail(401, "Invalid email or password");
        signedIn = true;
        return { user: USER };
      },
    });
    render(app());
    expect(screen.queryByText("the app")).toBeNull();
    await userEvent.type(await screen.findByLabelText("Email"), "ann@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "Wr0ng$ecretPassw0rd");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    expect(screen.queryByText("the app")).toBeNull();
    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(screen.getByText("ann@example.com")).toBeTruthy();
  });

  it("signs out and returns to the sign-in screen", async () => {
    let signedIn = true;
    const calls = stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "POST /api/auth/logout": () => {
        signedIn = false;
        return { ok: true };
      },
    });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.queryByText("the app")).toBeNull();
    expect(calls.map((c) => c.key)).toContain("POST /api/auth/logout");
  });

  it("sends the visitor back to sign-in when any other call says the session is gone", async () => {
    let signedIn = true;
    stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "GET /api/files": () => {
        signedIn = false;
        return fail(401, "Sign in required");
      },
    });
    render(app());
    await screen.findByText("the app");
    await fetch("/api/files"); // what the app does in the background
    const { getFiles } = await import("../src/api");
    await getFiles().catch(() => undefined);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("does not treat a wrong password (a 401 from an auth route) as an expired session", async () => {
    const calls = stubApi({ "GET /api/auth/me": () => me(null), "POST /api/auth/login": () => fail(401, "Invalid email or password") });
    render(app());
    await userEvent.type(await screen.findByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    expect(calls.filter((c) => c.key === "GET /api/auth/me")).toHaveLength(1); // no re-fetch loop
  });
});

describe("sign-up and email flows", () => {
  it("registers, then tells the visitor to check their email (and does not sign them in)", async () => {
    const calls = stubApi({ "GET /api/auth/me": () => me(null), "POST /api/auth/register": () => new Response(JSON.stringify({ pending: true }), { status: 202 }) });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/check your email/i)).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/register")!.body).toEqual({ email: "new@example.com", password: PASSWORD });
    expect(screen.queryByText("the app")).toBeNull();
  });

  it("shows the password rule on the sign-up form and surfaces the server's message", async () => {
    stubApi({ "GET /api/auth/me": () => me(null), "POST /api/auth/register": () => fail(400, "Password must be 12 to 128 characters") });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    expect(screen.getByText(/at least 12 characters/i)).toBeTruthy();
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pw.minLength).toBe(12);
    expect(pw.maxLength).toBe(128);
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.type(pw, "x".repeat(12));
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/12 to 128/);
  });

  it("hides email sign-up when the server cannot send email", async () => {
    stubApi({ "GET /api/auth/me": () => me(null, { emailEnabled: false, googleConfigured: true }) });
    render(app());
    await screen.findByRole("link", { name: "Continue with Google" });
    expect(screen.queryByRole("button", { name: "Create an account" })).toBeNull();
    expect(screen.queryByText("Forgot password?")).toBeNull();
  });

  it("offers to resend the verification email when sign-in is refused as unverified", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => me(null),
      "POST /api/auth/login": () => fail(403, "Verify your email before signing in", "email_unverified"),
      "POST /api/auth/resend-verification": () => ({ ok: true }),
    });
    render(app());
    await userEvent.type(await screen.findByLabelText("Email"), "ann@example.com");
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.click(await screen.findByRole("button", { name: "Resend verification email" }));
    expect(await screen.findByText(/sent/i)).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/resend-verification")!.body).toEqual({ email: "ann@example.com" });
  });

  it("answers forgot-password the same way whatever the address", async () => {
    const calls = stubApi({ "GET /api/auth/me": () => me(null), "POST /api/auth/forgot-password": () => ({ ok: true }) });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    await userEvent.type(screen.getByLabelText("Email"), "anyone@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(/if that address has an account/i)).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/forgot-password")!.body).toEqual({ email: "anyone@example.com" });
  });

  it("opens the reset form from #reset_token=, removes the token from the address bar, and signs in on success", async () => {
    window.history.replaceState({}, "", "/#reset_token=tok123");
    let signedIn = false;
    const calls = stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "POST /api/auth/reset-password": () => {
        signedIn = true;
        return { user: USER };
      },
    });
    render(app());
    expect(await screen.findByRole("heading", { name: /choose a new password/i })).toBeTruthy();
    expect(window.location.hash).toBe(""); // the token no longer sits in the URL or history
    expect(window.location.search).toBe("");
    await userEvent.type(screen.getByLabelText("New password"), "N3w$ecretPassw0rd!");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/reset-password")!.body).toEqual({ token: "tok123", password: "N3w$ecretPassw0rd!" });
  });

  it("opens the confirm screen from #verify_token=, asks for the sign-up password, cleans the address bar, and signs in", async () => {
    window.history.replaceState({}, "", "/#verify_token=vt123");
    let signedIn = false;
    const calls = stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "POST /api/auth/verify-email": () => {
        signedIn = true;
        return { user: USER };
      },
    });
    render(app());
    expect(await screen.findByRole("heading", { name: /confirm your email/i })).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(screen.queryByLabelText("Email")).toBeNull(); // the link already says whose it is
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByText("the app")).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/verify-email")!.body).toEqual({ token: "vt123", password: PASSWORD });
  });

  it("explains a wrong confirm password and points to Forgot password, without losing the screen", async () => {
    window.history.replaceState({}, "", "/#verify_token=vt123");
    stubApi({
      "GET /api/auth/me": () => me(null),
      "POST /api/auth/verify-email": () => fail(400, "That is not the password used to sign up. If you signed up earlier with a different password, use Forgot password.", "verify_password"),
    });
    render(app());
    await userEvent.type(await screen.findByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/forgot password/i);
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm email" })).toBeTruthy(); // can try again
  });

  it("says when the confirm link is no longer valid", async () => {
    window.history.replaceState({}, "", "/#verify_token=old");
    stubApi({ "GET /api/auth/me": () => me(null), "POST /api/auth/verify-email": () => fail(400, "This verification link is invalid or has expired", "verify_invalid") });
    render(app());
    await userEvent.type(await screen.findByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid or has expired/);
    await userEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("explains a failed Google attempt from the address", async () => {
    stubApi({ "GET /api/auth/me": () => me(null) });
    window.history.replaceState({}, "", "/?error=google_failed");
    render(app());
    expect(await screen.findByText(/google sign-in/i)).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("links to Google sign-in (a full-page redirect) only when the server has it configured", async () => {
    stubApi({ "GET /api/auth/me": () => me(null, { googleConfigured: true }) });
    render(app());
    const link = await screen.findByRole("link", { name: "Continue with Google" });
    expect(link.getAttribute("href")).toBe("/api/auth/google");
  });
});

describe("account menu", () => {
  it("signs out of every device and returns to sign-in", async () => {
    let signedIn = true;
    const calls = stubApi({
      "GET /api/auth/me": () => me(signedIn ? USER : null),
      "POST /api/auth/logout-all": () => {
        signedIn = false;
        return { ok: true };
      },
    });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(calls.map((c) => c.key)).toContain("POST /api/auth/logout-all");
  });

  it("changes the password with the current one and reports the result", async () => {
    const calls = stubApi({ "GET /api/auth/me": () => me(USER), "POST /api/auth/change-password": () => ({ ok: true }) });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog", { name: "Change password" });
    await userEvent.type(within(dialog).getByLabelText("Current password"), PASSWORD);
    await userEvent.type(within(dialog).getByLabelText("New password"), "N3w$ecretPassw0rd!");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText(/password changed/i)).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/change-password")!.body).toEqual({ currentPassword: PASSWORD, newPassword: "N3w$ecretPassw0rd!" });
  });

  it("shows the server's message when the current password is wrong", async () => {
    stubApi({ "GET /api/auth/me": () => me(USER), "POST /api/auth/change-password": () => fail(400, "Current password is incorrect") });
    render(app());
    await userEvent.click(await screen.findByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog", { name: "Change password" });
    await userEvent.type(within(dialog).getByLabelText("Current password"), PASSWORD);
    await userEvent.type(within(dialog).getByLabelText("New password"), "N3w$ecretPassw0rd!");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Current password is incorrect");
  });

  it("gives each signed-in user a fresh app (nothing carries over from the last one)", async () => {
    let current = USER;
    let signedIn = true;
    stubApi({
      "GET /api/auth/me": () => me(signedIn ? current : null),
      "POST /api/auth/logout": () => {
        signedIn = false;
        return { ok: true };
      },
      "POST /api/auth/login": () => {
        current = { id: 2, email: "bob@example.com", displayName: "bob", avatarUrl: null };
        signedIn = true;
        return { user: current };
      },
    });
    const Counter = () => {
      const [n] = (window as any).__state ?? [0];
      return <div>{`state:${n}`}</div>;
    };
    (window as any).__state = ["ann-state"];
    render(
      <AuthGate>
        <Counter />
      </AuthGate>,
    );
    expect(await screen.findByText("state:ann-state")).toBeTruthy();
    (window as any).__state = ["cleared"]; // a remount reads this; a kept instance would not
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.type(await screen.findByLabelText("Email"), "bob@example.com");
    await userEvent.type(screen.getByLabelText("Password"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("state:cleared")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeTruthy());
  });
});

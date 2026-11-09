// Sign in / restore purchase. The anonymous user is LINKED to an email, Apple or Google identity so user id and
// `subscriptions` are kept. On a reinstall the person signs in and lands on the same user, so the plan is still there.
// Apple/Google need provider settings in Supabase (Authentication > Providers). Email works with Supabase's default mailer.

export type Provider = "apple" | "google";
export type AccountResult = "sent" | "redirect" | "error";

const redirectTo = () => `${window.location.origin}${window.location.pathname}`;

/** True when the current session is a real account (not anonymous). */
export async function isSignedIn(): Promise<boolean> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const { data } = await supabase.auth.getUser();
    return !!data.user && !data.user.is_anonymous;
  } catch {
    return false;
  }
}

/** Apple / Google. Link first (keeps the anonymous user); if that identity already belongs to a user, sign in as it instead. */
export async function continueWithProvider(provider: Provider): Promise<AccountResult> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const linked = await supabase.auth.linkIdentity({ provider, options: { redirectTo: redirectTo() } });
    if (!linked.error) return "redirect";
    const signed = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: redirectTo() } });
    return signed.error ? "error" : "redirect";
  } catch {
    return "error";
  }
}

/** Email. A new address is linked to the anonymous user (confirmation mail); a known one gets a sign-in link. */
export async function continueWithEmail(email: string): Promise<AccountResult> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const upd = await supabase.auth.updateUser({ email }, { emailRedirectTo: redirectTo() });
    if (!upd.error) return "sent";
    const otp = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo() } });
    return otp.error ? "error" : "sent";
  } catch {
    return "error";
  }
}

export async function signOut(): Promise<void> {
  try {
    const { supabase } = await import("./supabase.ts");
    await supabase.auth.signOut();
  } catch {
    // ignore
  }
}

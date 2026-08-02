// Login helper shared by every flow. HANDOFF §5a: React controlled inputs expose no `value`
// attribute, so selectors go by label, not by value — the login form's two fields are wrapped
// (implicit) <label>s, which Playwright's getByLabel resolves against the input they contain.
export async function login(page, baseURL, username, password) {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${baseURL}/`, { timeout: 15000 });
  // Shell.tsx renders the nav only after /api/auth/me resolves. "Parts" is on every fixture
  // user's nav (both the admin and the permission-gating flow's restricted user hold
  // parts.view), so waiting for it is a reliable "signed in and hydrated" checkpoint before a
  // flow's own navigation starts.
  await page.getByRole("link", { name: "Parts" }).waitFor({ state: "visible", timeout: 15000 });
}

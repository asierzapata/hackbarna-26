import { SignInButton } from "./SignInButton";

export function HeaderBar() {
  return (
    <header className="header-bar">
      <div className="header-bar__brand">// KAN</div>
      <div className="header-bar__slot" />
      <SignInButton />
    </header>
  );
}

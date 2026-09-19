import { Outlet, createRootRoute } from "@tanstack/react-router";
import { BugReporter } from "@/components/BugReporter";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return <><Outlet /><BugReporter /></>;
}

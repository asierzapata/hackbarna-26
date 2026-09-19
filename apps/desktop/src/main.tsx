import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./styles.css";
import { recordQaError } from "./lib/qa-errors";

window.addEventListener("error", (event) => recordQaError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => recordQaError(event.reason));

const router = createRouter({ routeTree });

if (import.meta.env.DEV) {
  const devWindow = window as Window & { __kanErrors?: string[] };
  devWindow.__kanErrors = [];
  window.addEventListener("error", (event) => {
    devWindow.__kanErrors?.push(event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    devWindow.__kanErrors?.push(
      reason instanceof Error ? reason.message : String(reason),
    );
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

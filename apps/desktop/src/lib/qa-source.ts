import * as React from "react";
import { qaRegistry } from "./qa-context";

export function useQaSource(name: string, read: () => unknown) {
  const latest = React.useRef(read);
  React.useLayoutEffect(() => { latest.current = read; });
  const route = window.location.pathname;
  React.useEffect(() => qaRegistry.register(route, name, () => latest.current()), [route, name]);
}

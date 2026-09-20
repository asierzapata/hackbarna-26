const appIcon = new URL("../../src-tauri/icons/source.png", import.meta.url).href;

export function KanBrand() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 font-heading text-sm font-semibold tracking-tight text-foreground">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 48 48"
        className="size-7 shrink-0"
        fill="currentColor"
      >
        <path d="M8 3h7v9l-7 7V3ZM34 3h8L22 23v-2h-4L34 3ZM15 22h7v7h-7v-7ZM23 28l20 17h-9L19 30h4v-2ZM8 37l5-6 2 2v12H8v-8Z" />
        <circle cx="6" cy="35" r="5" className="fill-agent" />
        <circle cx="42" cy="24" r="3" className="fill-suggestion" />
      </svg>
      <span>Kan</span>
    </span>
  );
}

export function KanAppIcon() {
  return (
    <img
      src={appIcon}
      alt=""
      width={80}
      height={80}
      draggable={false}
      className="mb-2 size-20 shrink-0 object-contain"
    />
  );
}

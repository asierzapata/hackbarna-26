for (const form of document.querySelectorAll("[data-waitlist-form]")) {
  const button = form.querySelector('button[type="submit"]');
  const email = form.querySelector('input[type="email"]');
  const status = form.querySelector("[role=status]");
  const label = [...button.childNodes];
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    button.textContent = "Joining…";
    form.setAttribute("aria-busy", "true");
    status.textContent = "";
    status.dataset.state = "pending";
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.value, consent: true, website: form.elements.website.value }),
        signal: AbortSignal.timeout(12000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error || "Signup is temporarily unavailable. Please try again soon.");
      status.dataset.state = "success";
      status.textContent = "You’re on the list. We’ll email you when there’s more to share.";
      form.reset();
      button.textContent = "You’re on the list";
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error instanceof Error && !["TypeError", "SyntaxError", "TimeoutError", "AbortError"].includes(error.name)
        ? error.message : "We couldn’t confirm your signup. Please try again.";
      button.replaceChildren(...label);
    } finally {
      form.removeAttribute("aria-busy");
      button.disabled = false;
    }
  });
  email.addEventListener("input", () => {
    if (form.hasAttribute("aria-busy")) return;
    status.textContent = "";
    button.replaceChildren(...label);
  });
}

function revealLinkedDetails() {
  const target = document.getElementById(location.hash.slice(1));
  if (!(target instanceof HTMLDetailsElement)) return;
  target.open = true;
  target.querySelector("summary")?.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}
window.addEventListener("hashchange", revealLinkedDetails);
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (link?.getAttribute("href") === location.hash) revealLinkedDetails();
});
revealLinkedDetails();

const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
if (!motionPreference.matches && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  for (const section of document.querySelectorAll(".product-copy, .product-evidence, .use-cases-heading, .use-case")) {
    section.classList.add("reveal-on-scroll");
    observer.observe(section);
  }
  motionPreference.addEventListener("change", () => {
    if (!motionPreference.matches) return;
    observer.disconnect();
    document.querySelectorAll(".reveal-on-scroll").forEach(section => section.classList.add("is-revealed"));
  });
}

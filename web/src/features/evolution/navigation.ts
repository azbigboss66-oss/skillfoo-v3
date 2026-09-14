// Only explicit "view details/mechanism" actions call this; selecting a stage never scrolls.
export function revealSection(id: string, reduced: boolean) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const target = document.getElementById(id);
    if (!target) return;
    let parent: HTMLElement | null = target;
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' });
  }));
}

/**
 * Promote a declaratively rendered dialog to the browser's modal top layer.
 * This is an intentionally small browser boundary; Svelte still owns the
 * dialog's lifetime, state, events, and contents.
 */
export const modal = (node: HTMLDialogElement): { destroy: () => void } => {
  node.showModal();

  return {
    destroy: () => {
      if (node.open) {
        node.close();
      }
    },
  };
};

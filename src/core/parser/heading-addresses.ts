import { projectMap, type DocumentModel, type SectionNode } from "markdown-patch";

/** Keep canonical map keys tied to the original nodes, including duplicate siblings. */
export function createHeadingAddressResolver(model: DocumentModel): {
  pathOf(section: SectionNode): string[];
  resolve(path: readonly string[] | null): SectionNode | undefined;
} {
  const paths = new Map<SectionNode, string[]>([[model.root, []]]);
  function pathOf(section: SectionNode): string[] {
    const cached = paths.get(section);
    if (cached) return cached;
    // Preserve the original parent/sibling references: projection then supplies
    // its own duplicate suffix without decoding or duplicating that algorithm.
    // A single projected root key also avoids numeric-key enumeration ordering.
    const key = Object.keys(projectMap({ ...model,
      root: { ...model.root, children: [section], blocks: [] },
    }).headings)[0]!;
    const result = [...pathOf(section.parent!), key];
    paths.set(section, result);
    return result;
  }
  function resolve(path: readonly string[] | null): SectionNode | undefined {
    let section = model.root;
    for (const key of path ?? []) {
      const child = section.children.find(candidate => pathOf(candidate).at(-1) === key);
      if (!child) return undefined;
      section = child;
    }
    return section;
  }
  return { pathOf, resolve };
}

import { Table as GeistdocsTable } from "@vercel/geistdocs/components/table";
import { createMdxComponents } from "@vercel/geistdocs/mdx";
import type { MDXComponents } from "mdx/types";
import { Children, type ComponentProps, isValidElement } from "react";
import { Check, Cross, Warn } from "@/components/custom/status-icons";
import { AdapterSlugList } from "./adapter-slug-list";
import { FeatureSupport } from "./feature-support";
import { GlobalFeatureMatrix } from "./global-feature-matrix";
import { PackageInstall } from "./package-install";

// The Geistdocs table scrolls inside a wrapper that keyboard users cannot
// focus. Move scrolling to a focusable region around it so wide tables can be
// scrolled with the arrow keys.
const Table = (props: ComponentProps<"table">) => (
  <div
    aria-label="Table"
    className="overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-700 [&>div]:overflow-visible"
    role="region"
    tabIndex={0}
  >
    <GeistdocsTable {...props} />
  </div>
);

const NESTED_LIST_TAGS = new Set(["ol", "ul"]);

const isNestedList = (node: unknown) =>
  isValidElement(node) &&
  typeof node.type === "string" &&
  NESTED_LIST_TAGS.has(node.type);

// GFM task list items render a bare checkbox. Wrapping the item's own text in
// a label gives the checkbox an accessible name. A nested list stays outside
// the label so its text and checkboxes are not folded into this item's name.
const ListItem = ({ children, className, ...props }: ComponentProps<"li">) => {
  if (!className?.includes("task-list-item")) {
    return (
      <li className={className} {...props}>
        {children}
      </li>
    );
  }
  const nodes = Children.toArray(children);
  const nestedListIndex = nodes.findIndex(isNestedList);
  const labelEnd = nestedListIndex === -1 ? nodes.length : nestedListIndex;
  return (
    <li className={className} {...props}>
      <label>{nodes.slice(0, labelEnd)}</label>
      {nodes.slice(labelEnd)}
    </li>
  );
};

export const getMDXComponents = (
  components?: MDXComponents
): MDXComponents =>
  createMdxComponents({
    li: ListItem,
    table: Table,
    Table,

    Check,
    Cross,
    Warn,

    FeatureSupport,
    GlobalFeatureMatrix,
    AdapterSlugList,
    PackageInstall,

    // User components last to allow overwriting defaults
    ...components,
  });

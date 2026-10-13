import { createMdxComponents } from "@vercel/geistdocs/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { Check, Cross, Warn } from "@/components/custom/status-icons";
import { AdapterSlugList } from "./adapter-slug-list";
import { FeatureSupport } from "./feature-support";
import { GlobalFeatureMatrix } from "./global-feature-matrix";
import { PackageInstall } from "./package-install";

// GFM task list items render a bare checkbox. Wrapping the item in a label
// gives the checkbox its text as an accessible name.
const ListItem = ({ children, className, ...props }: ComponentProps<"li">) => (
  <li className={className} {...props}>
    {className?.includes("task-list-item") ? (
      <label>{children}</label>
    ) : (
      children
    )}
  </li>
);

export const getMDXComponents = (
  components?: MDXComponents
): MDXComponents =>
  createMdxComponents({
    li: ListItem,

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

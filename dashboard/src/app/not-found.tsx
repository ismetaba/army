import Link from "next/link";

/** Themed 404 — `notFound()` from the workspace and run pages lands here. */
export default function NotFound() {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-16 text-center">
      <p className="text-lg font-semibold tracking-tight">Not found</p>
      <p className="mt-2 text-sm text-muted">
        No such workspace or run in this store. It may have been deleted, or{" "}
        <span className="font-mono">AW_HOME</span> may point somewhere else.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm text-link hover:underline">
        Back to workspaces
      </Link>
    </div>
  );
}

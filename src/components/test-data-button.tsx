/**
 * "Fill test data" for the closer and validator forms.
 *
 * Local development only. `import.meta.env.DEV` is replaced with `false` in a
 * production build, so this renders nothing and the generator behind `onFill`
 * is dropped from the deployed bundle. The dev server talks to the same
 * database as production, which is why the sample name starts with `TEST`: a
 * lead submitted from it is a real row, easy to find and archive.
 */
export function TestDataButton({ onFill }: { onFill: () => void }) {
  if (!import.meta.env.DEV) return null;

  return (
    <button
      type="button"
      className="chip"
      onClick={onFill}
      title="Development only: fills the form with sample data. You still press Submit."
    >
      Fill test data
    </button>
  );
}

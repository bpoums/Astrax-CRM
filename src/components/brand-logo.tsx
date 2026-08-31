/**
 * The ASTRAX lockup: the X mark, the wordmark, and the tagline beneath it.
 *
 * Served as a static file rather than inlined. The artwork is traced, about a
 * thousand paths and a third of a megabyte, and inlining it put all of that
 * into the chunk behind every page in the app — `AppHeader` is on all of them.
 * As an `<img>` it is one cacheable request, fetched once and reused for the
 * rest of the session, and it costs the bundle nothing.
 *
 * It stays just as crisp: an SVG is a vector whether the browser reads it from
 * the markup or from a file. Inlining only buys something when CSS needs to
 * recolour the artwork through `currentColor`, and every path here carries its
 * own fixed fill.
 *
 * `public/logo.svg` keeps its intrinsic `width`/`height` alongside the viewBox,
 * so the browser knows the 885x176 aspect ratio before the file arrives. Set
 * the height and leave the width auto — the box is then correct from first
 * paint, with no reflow as the image loads.
 *
 * `max-w-none` is not optional. Tailwind's preflight applies
 * `img { max-width: 100% }` to every image, which caps the width at whatever
 * the parent happens to be while `h-7` still pins the height — and a 5:1
 * lockup squashed into a narrower box turns the wordmark into a smear while
 * the near-square icon beside it still reads. `w-auto` does not defeat that
 * cap and neither does `shrink-0`; only lifting the max-width does.
 */
export function BrandLogo({
  className = "h-7 w-auto max-w-none shrink-0",
}: {
  className?: string;
}) {
  return <img src="/logo.png" alt="ASTRAX" className={className} />;
}

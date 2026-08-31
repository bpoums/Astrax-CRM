import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The pipelines are tabs on /cx now, not separate pages. This route stays so
 * that any link written while they were separate still lands in the right
 * place instead of 404ing.
 */
export const Route = createFileRoute("/_authenticated/cx/chargeback")({
  beforeLoad: () => {
    throw redirect({ to: "/cx", search: { tab: "chargeback" }, replace: true });
  },
  head: () => ({ meta: [{ title: "Chargeback Pipeline | ASTRAX" }] }),
});

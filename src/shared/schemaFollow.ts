/// Which schema each member of a set is on, after one of them is changed.
///
/// A set is the same logical database in several places, so its members
/// usually sit in step — all on `acme_app` — and moving one to
/// `acme_billing` almost always means moving them all. Asking for the same
/// change once per member is busywork, and forgetting one compares two
/// unrelated schemas.
///
/// So the others follow, but only the ones that were in step with the one
/// changed (a member deliberately on another name — `acmeprod` where the
/// rest are `acme` — stays put), and only onto a schema they are known to
/// have. A member whose schema list is not known is left alone rather than
/// pointed at a name that may not exist there.
export function followSchema(
  current: Record<string, string>,
  changed: string,
  next: string,
  available: Record<string, string[]>,
): { schemas: Record<string, string>; followed: string[] } {
  const before = current[changed] ?? '';
  const schemas = { ...current, [changed]: next };
  const followed: string[] = [];
  if (!before) return { schemas, followed };
  for (const [id, name] of Object.entries(current)) {
    if (id === changed || name !== before) continue;
    if (!(available[id] ?? []).includes(next)) continue;
    schemas[id] = next;
    followed.push(id);
  }
  return { schemas, followed };
}

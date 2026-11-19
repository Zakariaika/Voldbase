# 0020 — Licensing model: source-available, non-commercial by default

- Status: Proposed (draft documents; legal review required before this is treated as final)
- Date: 2026-11-19
- Supersedes: [0001](0001-product-scope.md), decision 5 (licensing only)

## Context

ADR-0001 decided that "V0.1 is local-first and open source (MIT)", and the
repository has been distributed under the MIT License since its first commit.
The owner's actual policy is different: commercial use, selling, sublicensing
and commercial redistribution are meant to require explicit permission, and the
VOLDBASE name and visual identity are meant to identify this project only.

MIT cannot express that policy. It grants everyone the right to use, copy,
modify, merge, publish, distribute, sublicense and sell the software, for any
purpose, including commercial and internal business use, royalty-free and
irrevocably. Keeping MIT in `LICENSE` while documenting a non-commercial policy
elsewhere would leave two contradictory grants in the same repository, and the
more permissive one would win for anyone who relied on it.

The repository is also only at the stage of documenting a policy: it has not had
legal review and the governing law is not chosen. The copyright holder line is
being restated as the person's name, the owner having confirmed that the GitHub
handle "Zakariaika" and Taqiyeddin Maatlia are the same person, so no separate
author and no transfer of copyright is involved. A final license cannot honestly
be claimed yet, and the documents must not pretend otherwise.

## Decision

1. **Replace the MIT license text with a clearly labelled draft** of a
   source-available, non-commercial license in `LICENSE`, versioned `0.1-draft`.
   The draft states that it has not been legally reviewed and is not a claim of
   enforceability, in its own first section rather than in a footnote.

2. **Grant non-commercial permission and reserve everything else.** Personal,
   educational and other non-commercial use, non-commercial modification,
   non-commercial redistribution of unmodified copies, non-commercial
   distribution of modified versions that meet the conditions in `LICENSE` 4.2,
   and non-commercial contributions are permitted. Commercial use (including
   purely internal business use), selling, sublicensing and commercial
   distribution — of the Software or of any modified version — require prior
   written permission.

3. **Define scope explicitly.** `LICENSE` section 3 lists covered paths
   (`src/`, `bin/`, `tests/`, `docs/`, original root documents and
   configuration) and excludes third-party components, contributors' work, the
   Brand, and any file carrying its own header. Third-party material is governed
   by its own license; contributor copyright is never claimed.

4. **Add `NOTICE`.** It carries the copyright line, the third-party component
   table with licenses, the prior-licensing (MIT) record, the contributor
   position, and statements that the current version does not execute imported
   project code and does not provide a validated security guarantee.

5. **Add `TRADEMARKS.md`.** Name, logo and visual identity are not licensed by
   `LICENSE`. Factual references are allowed; anything suggesting official
   affiliation, or naming a fork VOLDBASE, is not. No trademark registration is
   claimed.

6. **Remove the machine-readable MIT grant.** `package.json` no longer declares
   `"license": "MIT"`; it uses the npm convention `SEE LICENSE IN LICENSE`, and
   the lockfile root entry follows. This is metadata only: no source file, test,
   build output or application behavior changes.

7. **Do not rewrite the historical record.** ADR-0001 is marked superseded for
   its licensing decision only; its product-scope decisions remain in force. The
   README license section is corrected so no current document still advertises
   MIT for future distributions.

8. **Make redistribution a direct grant, not a sublicense.** Passing on an
   unmodified copy, or distributing a modified version that meets `LICENSE` 4.2,
   is permitted free of charge; the recipient receives their own non-commercial
   permission from the Copyright Holder under `LICENSE` 4.1, and the
   redistributor grants nothing in the Software and adds no terms to it.
   Non-transferability and non-sublicensability therefore do not conflict with
   4.1(c) or 4.2: the copy is passed on, the permission is not moved (`LICENSE`
   4.4). A modified version's own original additions remain the modifier's to
   license, and no redistribution grants a recipient a commercial right
   (`LICENSE` 4.5).

9. **State the contribution grant precisely.** Contributors keep copyright; the
   license back is a perpetual, irrevocable, transferable, sublicensable right
   to reproduce, modify, distribute and relicense the contribution as part of
   the Software, including under commercial terms, and it is accepted only by
   submitting under these terms or under separate written terms. It is a
   license, not an assignment, and no ownership of a contribution is claimed
   (`LICENSE` 8).

10. **Permit non-commercial distribution of modified versions, under named
    conditions.** `LICENSE` 4.2 allows a modified version to be distributed
    non-commercially only if it uses a different name, uses none of the official
    identity, states that it is modified, unofficial and unaffiliated, preserves
    every copyright, license and third-party notice, implies no endorsement, and
    ships the license texts for recipients; the distribution must be free of
    charge and unmonetised. This replaces the earlier draft's requirement of
    written permission for every distribution of a modified version, and it
    keeps commercial distribution behind `LICENSE` 5. `LICENSE` 4.3 and 4.5 are
    worded so that the new permission cannot be read as a commercial right.

## Consequences

- **The project is no longer open source** in the OSI sense, and must not be
  described as such. "Source-available" is the accurate term. The roadmap,
  marketing copy and package metadata must not claim otherwise.
- **Earlier MIT grants are not revoked for copies already obtained.** This
  license applies to repository contents from the commit that introduces it. It
  is not retroactive and does not cancel permissions already granted for earlier
  versions, releases or copies (`LICENSE` 3.6, `NOTICE` 3). What applies to a
  given version therefore depends on when it was obtained; the exact
  commit/tag/release boundary is left as an open question rather than asserted.
- **Contribution friction increases.** Contributors must accept the terms in
  `LICENSE` section 8, which license the contribution to the Copyright Holder
  broadly enough to relicense the project commercially, while copyright stays
  with the contributor. Some contributors will decline that; it is a consequence
  of the policy, not a defect in the draft. Jurisdictions with non-waivable
  moral rights still need legal review (recorded as an open question).
- **Non-commercial forks are now permitted, and the controls are names and
  notices.** A fork may be published, renamed and distributed free of charge,
  so `LICENSE` 4.2's conditions and the trademark policy are what keep the
  official product identifiable. Compliance is not technically enforced; the
  open question is whether the conditions are sufficient in practice.
- **Commercial enquiries need a real channel.** `LICENSE` section 5 points to
  the repository owner account. A written permission process (scope, term,
  fee, attribution) does not exist yet and is a follow-up deliverable.
- **The draft is not a control.** Nothing here prevents copying, and a draft
  that is never reviewed provides weaker protection than a reviewed final
  license. Legal review is the next step, not an optional one.
- **No code impact.** No source file, test, build step, CLI behavior, storage
  format or execution capability is touched by this ADR.

## Alternatives considered

- **Keep MIT and rely on a policy document.** Rejected: an explicit MIT grant
  overrides an informal policy, and the contradiction is exactly what this
  change exists to remove.
- **Business Source License (BUSL) or PolyForm Noncommercial.** Not adopted:
  both are written for a defined change date or a specific licensor structure,
  and neither matches the intended combination of allowed personal
  modification, permissioned commercial use and a reserved brand. They remain
  reasonable inputs to legal review.
- **A proprietary, all-rights-reserved license.** Rejected: it would forbid the
  educational and personal use the owner intends to allow, and would make the
  source-available publication pointless.
- **Add a `LICENSE` draft but leave `package.json` and the README alone.**
  Rejected: it leaves machine-readable and human-readable MIT grants in place,
  which is the contradiction this ADR is meant to remove.
- **Rewrite or delete ADR-0001.** Rejected: accepted ADRs are immutable in this
  repository; the record is superseded, not edited away.
- **Claim the draft is a final, enforceable license.** Rejected as dishonest;
  the documents must state exactly what has not been reviewed.
- **Forbid all distribution of modified versions.** Rejected by the owner:
  publishing a non-commercial fork is part of the intended permission, and the
  conditions in `LICENSE` 4.2 address renaming, branding and notices without a
  case-by-case permission request.

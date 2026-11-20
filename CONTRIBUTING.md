# Contributing to VOLDBASE

VOLDBASE accepts non-commercial contributions only, and only from a contributor
who has recorded an explicit, affirmative acceptance of the contribution terms.
This page describes that procedure. The terms themselves are
[`LICENSE` section 8](LICENSE); this page does not replace them.

**Read [`LICENSE`](LICENSE) first.** VOLDBASE is source-available, not open
source. Commercial use, commercial distribution and selling require prior
written permission from the copyright holder (`LICENSE` section 5).

## What acceptance means

You keep the copyright you hold in your contribution, and an organisation that
holds it keeps it. Nothing is assigned, and the project does not claim ownership
of it (`LICENSE` 8.3). If you contribute material you do not own, you grant only
the rights you are authorised to grant, and the material must be identified and
properly licensed (`LICENSE` 8.2(b), 8.4).

By accepting the contribution terms you license your contribution to
Taqiyeddin Maatlia, the copyright holder, so that the project can maintain and
distribute it as part of VOLDBASE (`LICENSE` 8.4). That licence is:

| Right | Scope |
| --- | --- |
| Reproduce, store, archive | the contribution, as part of the Software |
| Modify and create derivative works | the contribution, as part of the Software |
| Distribute and publicly display | the contribution, as part of the Software or a derivative of it |
| Sublicense through multiple tiers | the contribution, as part of the Software |
| License under other terms, including commercial terms | the contribution, as part of the Software, including a future licence that replaces the current draft |

It is perpetual, irrevocable, worldwide, royalty-free, non-exclusive,
transferable and sublicensable for those purposes. It is a licence, not an
assignment.

The grant is to the copyright holder only. Recipients of VOLDBASE receive the
non-commercial permissions in `LICENSE` section 4.1 in your contribution, not
the rights in section 8.4, so no downstream recipient or fork maintainer can
relicense your work on commercial terms (`LICENSE` 4.4 and 8.5).

**The commercial relicensing permission.** The last row is the commercial
element, and it is the reason the grant is broad: `LICENSE` section 5 makes
commercial use available only by written permission, so the copyright holder
can grant that permission only if your contribution can be offered to a
licensee under commercial terms. The grant covers your contribution as part of
this Software only — not your other work, not your name or likeness, and not
any project of yours outside VOLDBASE.

It is the full extent of what you grant. No other right is taken, and nothing
in it obliges you to maintain, support or further contribute to the project.

## How to record acceptance

Acceptance is **not** inferred from opening a pull request, pushing a commit,
attaching a patch or opening an issue. Those acts alone do not record consent,
and a contribution without a recorded statement is not merged.

1. In your pull request, post a comment containing this statement, with your
   own name or GitHub handle filled in:

   > I have read and agree to the VOLDBASE Contribution Terms in `LICENSE`
   > section 8 for the contributions in this pull request. I confirm that:
   >
   > - I am the author of these contributions, or I have the right to submit
   >   them;
   > - I hold the rights needed to grant the licence in `LICENSE` section 8.4
   >   for the whole contribution, or the person or organisation that holds
   >   those rights has authorised me to grant that licence on these terms, and
   >   that authority is identified in this comment;
   > - any third-party material in the contribution is identified, is properly
   >   licensed, and its licence permits the grant in `LICENSE` section 8.4; and
   > - I understand that I keep any copyright I hold, and that nothing in this
   >   statement assigns copyright.
   >
   > Signed: _your name or GitHub handle_, _date (YYYY-MM-DD)_

   If you do not hold copyright in the contribution — for example because your
   employer, client or another organisation does — say so in the same comment,
   identify the rights holder, and state the authority you have to submit it. Do
   not claim copyright you do not hold.

2. If you are contributing on behalf of an organisation, or the contribution is
   owned or controlled by your employer, client or another organisation, that
   organisation must either authorise you, in the same comment, to grant the
   `LICENSE` section 8.4 licence, or agree separate written terms with the
   copyright holder. Do not submit until one of these is in place (`LICENSE` 8.1
   and 8.2(d)).

3. If you cannot use the pull request interface, send the same statement to the
   copyright holder in writing — through the repository owner account on GitHub
   (github.com/Zakariaika) — before or with the contribution, and it will be
   recorded with it.

The statement above is the whole of the acceptance: nothing is agreed by
silence, by a commit trailer, or by a "looks good to me" review.

An acceptance posted on a pull request covers the commits in it when the
statement was posted and any further commits you push to that same pull request
before it is merged. If the change becomes materially different, a maintainer
may ask you to confirm again before the merge. Opening a new pull request
requires a new statement, and if a pull request is split or replaced, post a
statement on each replacement.

## What maintainers must do

- Do not merge a contribution that has no recorded acceptance statement from
  the contributor.
- Record where the statement is (the pull request comment) so it stays with the
  contribution's history.
- Keep the recorded statement for as long as the contribution remains in the
  Software (`LICENSE` 8.10).
- Do not edit or reinterpret a contributor's statement, and do not accept one
  on a contributor's behalf.

## Limits of this procedure

This is a documented consent procedure, not a legal conclusion. It has not been
reviewed by a lawyer, and it is not a claim that it binds every contributor in
every jurisdiction, or that it is sufficient for the project's intended
relicensing flexibility. Non-waivable moral rights, corporate contributors,
contributors who are minors and the evidential weight of a pull request comment
are open questions recorded in [`NOTICE`](NOTICE) and
[ADR-0020](docs/adr/0020-licensing-model.md).

The statement identifies you by the name or handle you choose. It does not
verify your legal identity, that you own what you submit, or that you have
authority to license it; a GitHub account is not proof of any of those things.
If you are a minor, if you contribute in the course of employment or under a
contract that gives your employer rights in your work, or if your jurisdiction
requires a particular form of agreement, do not submit until the copyright
holder has agreed how to handle it.

## Practical notes

- Contribution scope, coding conventions and the checks a change must pass are
  in the [README](README.md#development). No source file, test or behaviour
  change is implied by this document.
- Do not contribute third-party code unless it is clearly identified, properly
  licensed for that use, and its notices are preserved (`LICENSE` 8.2(b)).
- Do not contribute code you are not authorised to license on these terms. If
  your employer or another organisation owns the code, obtain its authority (or
  separate written terms) before submitting.

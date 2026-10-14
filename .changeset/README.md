# Changesets

`@openstory/stitch` is the only package this releases. The app is private and is not versioned.

When a pull request changes the player in a way that should ship, add a changeset from the repo root:

```sh
bunx changeset
```

Write the changelog line, and pick patch, minor, or major.

Once Test passes on `main`, Release opens or updates a version pull request. Merging that pull request publishes to npm. Auth is trusted publishing for `.github/workflows/release.yml`. There is no npm token.

A change that should not release gets an empty changeset:

```sh
bunx changeset --empty
```

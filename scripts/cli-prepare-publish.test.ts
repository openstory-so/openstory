import { describe, expect, it } from 'vitest';

import {
  rewriteWorkspaceDeps,
  rewriteWorkspaceRange,
} from '../packages/cli/scripts/prepare-publish.mjs';

describe('rewriteWorkspaceRange', () => {
  it('turns workspace protocols into ranges npm can install', () => {
    expect(rewriteWorkspaceRange('workspace:^', '0.5.0')).toBe('^0.5.0');
    expect(rewriteWorkspaceRange('workspace:~', '0.5.0')).toBe('~0.5.0');
    expect(rewriteWorkspaceRange('workspace:*', '0.5.0')).toBe('0.5.0');
    expect(rewriteWorkspaceRange('workspace:', '0.5.0')).toBe('0.5.0');
    expect(rewriteWorkspaceRange('workspace:^0.5.0', '9.9.9')).toBe('^0.5.0');
  });
});

describe('rewriteWorkspaceDeps', () => {
  it('rewrites only workspace specs and reads the sibling version', () => {
    const pkg = {
      dependencies: { '@openstory/stitch': 'workspace:^', left: '^1.0.0' },
    };
    const changed = rewriteWorkspaceDeps(pkg, (name: string) =>
      name === '@openstory/stitch' ? '0.5.0' : undefined
    );
    expect(changed).toBe(true);
    expect(pkg.dependencies).toEqual({
      '@openstory/stitch': '^0.5.0',
      left: '^1.0.0',
    });
  });
});

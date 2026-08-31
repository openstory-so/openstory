import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

describe('Tooltip', () => {
  it('renders without an ancestor TooltipProvider', () => {
    expect(() =>
      renderToStaticMarkup(
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">Tip</button>
          </TooltipTrigger>
          <TooltipContent>Hello</TooltipContent>
        </Tooltip>
      )
    ).not.toThrow(/TooltipProvider/);
  });
});

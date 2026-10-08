import { TOOL_NAMES } from '../config/constants';
import { searchSources } from '../catalogues/catalogueSearch';

/**
 * Lets the assistant of a business with a catalogue library look things up in that business's OWN enabled
 * catalogues and linked official web pages. It reads through the current account context, so it can never
 * return another business's material; for a business without the library it returns nothing.
 */
export const searchCataloguesSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.SEARCH_CATALOGUES,
    description:
      "Search this business's official catalogues and linked official website pages for colours (names and codes), products, finishes, collections and colour advice. Call it before answering any product or colour question. Returns the most relevant passages with their source.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, in a few words — e.g. "Wonderwall Lux", "warm neutral bedroom colours", "1625 Soul", "Smooth Silk finish".' },
      },
      required: ['query'],
    },
  },
};

export async function searchCataloguesHandler(args: unknown): Promise<unknown> {
  const query = typeof (args as { query?: unknown })?.query === 'string' ? ((args as { query: string }).query).trim().slice(0, 200) : '';
  if (!query) return { error: 'query is required' };
  const results = searchSources(query);
  return {
    results,
    note: results.length
      ? 'Use only facts that appear in these passages. "website" passages are the current official source and win over older "catalogue" passages if they differ.'
      : 'No matching information was found in the approved sources. Say it is not currently available and offer to connect the customer with the team.',
  };
}

/**
 * GitHub Repository Extractor
 *
 * Extracts README and metadata from GitHub repositories using the GitHub API.
 * No authentication required for public repos.
 */

interface GitHubRepo {
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  stars: number;
  language: string | null;
  license: string | null;
  homepage: string | null;
  readme: string;
  defaultBranch: string;
}

export class GitHubExtractor {
  private baseUrl = 'https://api.github.com';

  /**
   * Parse GitHub URL to extract owner and repo name
   */
  parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    const patterns = [
      /github\.com\/([^\/]+)\/([^\/\?#]+)/,  // https://github.com/owner/repo
      /github\.com\/([^\/]+)\/([^\/]+)\.git/, // git clone URLs
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        let repo = match[2];
        // Remove .git suffix if present
        if (repo.endsWith('.git')) {
          repo = repo.slice(0, -4);
        }
        return { owner: match[1], repo };
      }
    }

    return null;
  }

  /**
   * Fetch repository metadata from GitHub API
   */
  async fetchRepoMetadata(owner: string, repo: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'mindstone-intelligence'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Fetch README content from GitHub API
   */
  async fetchReadme(owner: string, repo: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/readme`, {
      headers: {
        'Accept': 'application/vnd.github.raw',
        'User-Agent': 'mindstone-intelligence'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return 'No README found.';
      }
      throw new Error(`Failed to fetch README: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  /**
   * Extract repository information
   */
  async extract(url: string): Promise<GitHubRepo> {
    const parsed = this.parseGitHubUrl(url);
    if (!parsed) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }

    const { owner, repo } = parsed;

    // Fetch metadata and README in parallel
    const [metadata, readme] = await Promise.all([
      this.fetchRepoMetadata(owner, repo),
      this.fetchReadme(owner, repo)
    ]);

    return {
      owner,
      name: repo,
      description: metadata.description,
      topics: metadata.topics || [],
      stars: metadata.stargazers_count || 0,
      language: metadata.language,
      license: metadata.license?.spdx_id || null,
      homepage: metadata.homepage,
      readme,
      defaultBranch: metadata.default_branch || 'main'
    };
  }

  /**
   * Generate slug for library path
   */
  generateSlug(owner: string, repo: string): string {
    return `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  /**
   * Format extraction as markdown with frontmatter
   */
  formatAsMarkdown(repo: GitHubRepo, sourceUrl: string): {
    content: string;
    frontmatter: Record<string, any>;
  } {
    const title = `${repo.owner}/${repo.name}`;

    // Build content
    let content = `# ${title}\n\n`;

    if (repo.description) {
      content += `> ${repo.description}\n\n`;
    }

    content += `---\n\n`;

    // Add metadata section
    const metadata: string[] = [];
    if (repo.language) metadata.push(`**Language:** ${repo.language}`);
    if (repo.stars > 0) metadata.push(`**Stars:** ${repo.stars.toLocaleString()}`);
    if (repo.license) metadata.push(`**License:** ${repo.license}`);
    if (repo.homepage) metadata.push(`**Homepage:** ${repo.homepage}`);

    if (metadata.length > 0) {
      content += metadata.join(' • ') + '\n\n';
    }

    // Add README
    content += '## README\n\n';
    content += repo.readme;

    // Build frontmatter
    const frontmatter: Record<string, any> = {
      type: 'repository',
      source_url: sourceUrl,
      repo_owner: repo.owner,
      repo_name: repo.name,
      repo_full_name: title,
      description: repo.description,
      language: repo.language,
      stars: repo.stars,
      topics: repo.topics,
      license: repo.license,
      homepage: repo.homepage,
      default_branch: repo.defaultBranch,
      extracted_at: new Date().toISOString()
    };

    return { content, frontmatter };
  }
}

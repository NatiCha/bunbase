// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'BunBase',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/NatiCha/bunbase' }],
      sidebar: [
        { label: 'Introduction', slug: 'index' },
        { label: 'Quickstart', slug: 'quickstart' },
        {
          label: 'Guides',
          items: [
            { label: 'Schema', slug: 'schema' },
            { label: 'Configuration', slug: 'configuration' },
            { label: 'Rules', slug: 'rules' },
            { label: 'Hooks', slug: 'hooks' },
            { label: 'Jobs', slug: 'jobs' },
            { label: 'Client SDK', slug: 'client' },
            { label: 'Extending', slug: 'extending' },
            { label: 'Deployment', slug: 'deployment' },
          ],
        },
        {
          label: 'API Reference',
          autogenerate: { directory: 'api' },
        },
      ],
    }),
  ],
});

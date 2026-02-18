// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'TSBase',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/charlessqueri/tsbase' }],
      sidebar: [
        { label: 'Introduction', slug: 'index' },
        { label: 'Quickstart', slug: 'quickstart' },
        {
          label: 'Guides',
          items: [
            { label: 'Schema', slug: 'schema' },
            { label: 'Configuration', slug: 'configuration' },
            { label: 'Rules', slug: 'rules' },
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

declare module 'react-plotly.js' {
  import type { ComponentType, CSSProperties } from 'react';
  import type { Config, Data, Layout } from 'plotly.js';
  const Plot: ComponentType<{
    data: Data[];
    layout?: Partial<Layout>;
    config?: Partial<Config>;
    useResizeHandler?: boolean;
    style?: CSSProperties;
  }>;
  export default Plot;
}
declare module 'react-plotly.js/factory' {
  import type { ComponentType, CSSProperties } from 'react';
  import type { Config, Data, Layout } from 'plotly.js';
  const factory: (plotly: unknown) => ComponentType<{ data: Data[]; layout?: Partial<Layout>; config?: Partial<Config>; useResizeHandler?: boolean; style?: CSSProperties }>;
  export default factory;
}

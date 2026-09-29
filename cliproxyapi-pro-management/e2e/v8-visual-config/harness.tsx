import { parse } from 'yaml';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVisualConfig } from '../../src/hooks/useVisualConfig';

const snapshots: Array<{ input: string; output: string }> = [];
function Harness() {
  const config = useVisualConfig();
  const [yaml, setYaml] = useState('');
  const [output, setOutput] = useState('');
  const load = (input: string) => {
    setYaml(input);
    return config.loadVisualValuesFromYaml(input);
  };
  const save = () => {
    const result = config.applyVisualChangesToYaml(yaml);
    snapshots.push({ input: yaml, output: result });
    setOutput(result);
    return result;
  };
  Object.assign(window, {
    visualV8: {
      parse,
      load,
      save,
      patch: config.setVisualValues,
      values: () => config.visualValues,
      receipt: () => snapshots,
    },
  });
  return (
    <main>
      <h1>Visual config v8 E2E</h1>
      <textarea
        id="source"
        aria-label="Source YAML"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
      />
      <button id="load" onClick={() => load(yaml)}>
        Load YAML
      </button>
      <label>
        Client keys
        <textarea
          id="keys"
          value={config.visualValues.apiKeysText}
          onChange={(e) => config.setVisualValues({ apiKeysText: e.target.value })}
        />
      </label>
      <label>
        Proxy URL
        <input
          id="proxy"
          value={config.visualValues.proxyUrl}
          onChange={(e) => config.setVisualValues({ proxyUrl: e.target.value })}
        />
      </label>
      <button id="save" onClick={save}>
        Apply visual changes
      </button>
      <pre id="values">{JSON.stringify(config.visualValues, null, 2)}</pre>
      <textarea id="output" aria-label="Output YAML" readOnly value={output} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);

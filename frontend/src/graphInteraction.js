export function bindGraphSelection(graph, onSelectNode) {
  if (!graph || typeof onSelectNode !== 'function') return () => {};

  const handleNodeClick = event => {
    const id = event?.item?.getModel?.()?.id;
    if (id !== undefined && id !== null) onSelectNode(String(id));
  };
  const handleCanvasClick = () => onSelectNode(null);

  graph.on('node:click', handleNodeClick);
  graph.on('canvas:click', handleCanvasClick);

  return () => {
    graph.off('node:click', handleNodeClick);
    graph.off('canvas:click', handleCanvasClick);
  };
}

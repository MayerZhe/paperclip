export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  adapterType: string;
  adapterConfig: Record<string, string | number | boolean>;
  suggestedSkills: string[];
}

const BASE_ADAPTER_CONFIG = {
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  apiKey: "",
  temperature: 0.1,
} as const;

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "template-designer",
    name: "Designer",
    description: "视觉设计专家，UI/UX 审核，原型设计",
    icon: "🎨",
    adapterType: "claude-local",
    adapterConfig: { ...BASE_ADAPTER_CONFIG },
    suggestedSkills: ["design-review", "ui-component"],
  },
  {
    id: "template-writer",
    name: "Writer",
    description: "技术文档、博客文章、spec 写作",
    icon: "✍️",
    adapterType: "claude-local",
    adapterConfig: { ...BASE_ADAPTER_CONFIG },
    suggestedSkills: ["doc-writing", "content-review"],
  },
  {
    id: "template-developer",
    name: "Developer",
    description: "全栈开发，TypeScript/React/Node.js",
    icon: "💻",
    adapterType: "claude-local",
    adapterConfig: { ...BASE_ADAPTER_CONFIG },
    suggestedSkills: ["code-review", "testing"],
  },
  {
    id: "template-fullstack",
    name: "Full-Stack",
    description: "从架构到部署的全栈开发，包含 code review + testing",
    icon: "🚀",
    adapterType: "claude-local",
    adapterConfig: { ...BASE_ADAPTER_CONFIG },
    suggestedSkills: ["architecture", "code-review", "testing", "deployment"],
  },
];

const templatesById = new Map(AGENT_TEMPLATES.map((t) => [t.id, t]));

export function getAgentTemplateById(id: string): AgentTemplate | undefined {
  return templatesById.get(id);
}

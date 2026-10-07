import { ClineMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { Environment } from "../../../../../src/config"
import TaskHeader from "./TaskHeader"

const meta: Meta<typeof TaskHeader> = {
	title: "Views/Components/TaskHeader",
	component: TaskHeader,
	parameters: {
		layout: "padded",
		docs: {
			description: {
				component:
					"TaskHeader displays task information, token usage, cost, and provides controls for task management. It includes expandable details, context window visualization, and task timeline.",
			},
		},
	},
	decorators: [createStorybookDecorator()],
	argTypes: {},
}

export default meta
type Story = StoryObj<typeof TaskHeader>

// Helper to create mock task messages
const createTask = (text: string, images?: string[], files?: string[]): ClineMessage => ({
	ts: Date.now(),
	type: "say",
	say: "task",
	text,
	images,
	files,
})

// Helper to create mock messages for timeline
const createMessages = (): ClineMessage[] => [
	{
		ts: Date.now() - 300000,
		type: "say",
		say: "task",
		text: "Create a React component",
	},
	{
		ts: Date.now() - 240000,
		type: "say",
		say: "text",
		text: "I'll help you create a React component.",
	},
	{
		ts: Date.now() - 180000,
		type: "say",
		say: "tool",
		text: JSON.stringify({ tool: "write_to_file", path: "Component.tsx" }),
	},
	{
		ts: Date.now() - 120000,
		type: "say",
		say: "text",
		text: "Component created successfully.",
	},
]

export const Collapsed: Story = {
	args: {
		task: createTask("Create a responsive navigation component for a React application"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: false,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader in collapsed state showing task title, cost, and new task button.",
			},
		},
	},
}

export const Expanded: Story = {
	args: {
		task: createTask("Create a responsive navigation component for a React application"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader in expanded state showing full task details, context window, and timeline.",
			},
		},
	},
}

export const WithImages: Story = {
	args: {
		task: createTask(
			"Analyze these screenshots and identify UI issues",
			["https://via.placeholder.com/400x300?text=Screenshot1", "https://via.placeholder.com/400x300?text=Screenshot2"],
			undefined,
		),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with attached images displayed as thumbnails.",
			},
		},
	},
}

export const WithFiles: Story = {
	args: {
		task: createTask("Review these configuration files and suggest improvements", undefined, [
			"package.json",
			"tsconfig.json",
			"vite.config.ts",
		]),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with attached files displayed as thumbnails.",
			},
		},
	},
}

export const LongTaskText: Story = {
	args: {
		task: createTask(
			"Create a comprehensive e-commerce application with the following features:\n1. User authentication and authorization\n2. Product catalog with search and filtering\n3. Shopping cart functionality\n4. Checkout process with payment integration\n5. Order management system\n6. Admin dashboard for managing products and orders\n7. Responsive design for mobile and desktop\n8. Performance optimization and caching\n9. SEO optimization\n10. Analytics integration",
		),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with long task text that can be expanded to show full content.",
			},
		},
	},
}

export const HighTokenUsage: Story = {
	args: {
		task: createTask("Refactor large codebase with TypeScript migration"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
				actModeOpenRouterModelInfo: {
					contextWindow: 200000,
					maxTokens: 8000,
					supportsPromptCache: true,
				},
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader showing high token usage approaching context window limits.",
			},
		},
	},
}

export const NoCost: Story = {
	args: {
		task: createTask("Test local model with Ollama"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "ollama",
				actModeApiModelId: "llama3.2",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with local model (Ollama) showing no cost information.",
			},
		},
	},
}

export const WithProgressMessage: Story = {
	args: {
		task: createTask("Build a REST API with Express and MongoDB"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with progress checklist displayed in FocusChain component.",
			},
		},
	},
}

export const LocalEnvironment: Story = {
	args: {
		task: createTask("Test feature in local environment"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.local,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with local environment border color (yellow/orange warning).",
			},
		},
	},
}

export const StagingEnvironment: Story = {
	args: {
		task: createTask("Deploy to staging environment"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.staging,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with staging environment border color (blue).",
			},
		},
	},
}

export const ProductionEnvironment: Story = {
	args: {
		task: createTask("Deploy to production environment"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			environment: Environment.production,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: createMessages(),
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with production environment (default colors).",
			},
		},
	},
}

export const MinimalTask: Story = {
	args: {
		task: createTask("Fix typo"),
		onClose: () => console.log("Close clicked"),
	},
	decorators: [
		createStorybookDecorator({
			expandTaskHeader: true,
			apiConfiguration: {
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-3-5-sonnet-20241022",
			},
			clineMessages: [
				{
					ts: Date.now() - 60000,
					type: "say",
					say: "task",
					text: "Fix typo",
				},
				{
					ts: Date.now() - 30000,
					type: "say",
					say: "text",
					text: "Fixed the typo.",
				},
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "TaskHeader with minimal task showing basic functionality.",
			},
		},
	},
}

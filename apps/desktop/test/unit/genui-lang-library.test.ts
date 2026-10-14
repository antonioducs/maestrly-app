// Adapted from the OpenUI lang-core tests (packages/lang-core/src/__tests__/library.test.ts at f7109dd, MIT, Copyright
// (c) Thesys Inc.). See apps/desktop/resources/licenses/openui-MIT.txt. Cases for toSpec, library ids and custom
// actions are gone with those features; a component's own schema replaces upstream's `.ref`.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { action, steps } from '../../src/renderer/genui/lang/builtins'
import { createLibrary, defineComponent } from '../../src/renderer/genui/lang/library'
import { createParser } from '../../src/renderer/genui/lang/parser'
import { tagSchemaId } from '../../src/renderer/genui/lang/signature'

const prompt = (lib: ReturnType<typeof createLibrary>) => lib.prompt({ preamble: '# Test' })

describe('tagSchemaId', () => {
  it('action slots are ActionExpression or restricted @Name refs, $refs in JSON', () => {
    const Button = defineComponent({
      name: 'Button',
      props: z.object({
        label: z.string(),
        action: action().optional(),
        share: z.union([steps.ToAssistant.ref, steps.OpenUrl.ref]).optional(),
      }),
      description: 'A button',
      component: null,
    })
    const lib = createLibrary({ components: [Button], root: 'Button' })
    expect(prompt(lib)).toContain('action?: ActionExpression, share?: @ToAssistant | @OpenUrl)')
    expect(prompt(lib)).toContain('Put several steps in Action([...])')
    const schema = lib.toJSONSchema()
    expect(schema.$defs?.Button.properties?.action).toEqual({ $ref: '#/$defs/ActionExpression' })
    // A legacy object in an action slot is data, not a component: no type-mismatch
    const parsed = createParser(schema, 'Button').parse(
      'root = Button("x", {type: "continue_conversation", context: "x"})'
    )
    expect(parsed.meta.errors).toEqual([])
  })

  it('discovers a tagged schema inside an array, a union and an optional wrapper', () => {
    const item = z.object({ text: z.string() })
    tagSchemaId(item, 'ListItem')
    const text = z.object({ text: z.string() })
    tagSchemaId(text, 'TextNode')
    const image = z.object({ src: z.string() })
    tagSchemaId(image, 'ImageNode')
    const custom = z.any()
    tagSchemaId(custom, 'MyAction')
    const Card = defineComponent({
      name: 'Card',
      props: z.object({
        items: z.array(item),
        child: z.union([text, image]),
        act: custom.optional(),
      }),
      description: 'A card',
      component: null,
    })
    const text0 = prompt(createLibrary({ components: [Card], root: 'Card' }))
    expect(text0).toContain('items: ListItem[]')
    expect(text0).toContain('TextNode | ImageNode')
    expect(text0).toContain('act?: MyAction')
  })
})

describe('per-library registry', () => {
  it('keeps two libraries with the same component name apart', () => {
    const ButtonA = defineComponent({
      name: 'Button',
      props: z.object({ label: z.string() }),
      description: 'A',
      component: null,
    })
    const ButtonB = defineComponent({
      name: 'Button',
      props: z.object({ text: z.string() }),
      description: 'B',
      component: null,
    })
    expect(prompt(createLibrary({ components: [ButtonA], root: 'Button' }))).toContain('label: string')
    expect(prompt(createLibrary({ components: [ButtonB], root: 'Button' }))).toContain('text: string')
  })

  it('produces $defs with $ref pointers and the component descriptions', () => {
    const Text = defineComponent({
      name: 'TextContent',
      props: z.object({ text: z.string() }),
      description: 'Plain text content',
      component: null,
    })
    const Card = defineComponent({
      name: 'Card',
      props: z.object({ title: z.string(), children: z.array(z.union([Text.props])) }),
      description: 'card',
      component: null,
    })
    const schema = createLibrary({ components: [Text, Card], root: 'Card' }).toJSONSchema() as Record<string, any>
    expect(schema.$defs.TextContent.properties?.text).toBeDefined()
    expect(schema.$defs.TextContent.description).toBe('Plain text content')
    expect(JSON.stringify(schema.$defs.Card.properties?.children?.items)).toContain('#/$defs/TextContent')
  })

  it('refuses a props schema shared by two components, which upstream silently renamed', () => {
    const props = z.object({ labels: z.array(z.string()) })
    defineComponent({ name: 'BarChart', props, description: '', component: null })
    expect(() => defineComponent({ name: 'LineChart', props, description: '', component: null })).toThrow(
      'reuses the props schema'
    )
  })
})

describe('assertV4Schema', () => {
  it('throws for zod v3 schemas and accepts v4 ones', () => {
    expect(() =>
      defineComponent({
        name: 'Bad',
        props: { _def: { typeName: 'ZodObject' } } as any,
        description: '',
        component: null,
      })
    ).toThrow(/Zod 3 schema/)
    expect(() =>
      defineComponent({ name: 'Good', props: z.object({ name: z.string() }), description: '', component: null })
    ).not.toThrow()
  })
})

import type { FieldConfig, FieldLevel, FieldType } from './fields.ts';

/**
 * Starter families (plan Section 5.2, owner answer Q2). Adding one copies it into the shop as
 * ordinary fields and a family, which the merchant then edits. A field whose key already exists
 * with the same type is reused instead of copied.
 */
export interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  level: FieldLevel;
  config?: FieldConfig;
  options?: string[];
  required?: boolean;
  group?: string;
}

export interface Template {
  key: 'apparel' | 'furniture' | 'food' | 'spare_parts';
  name: string;
  description: string;
  fields: TemplateField[];
  /** Suggested option names and values for variants, such as Size: S, M, L. */
  options: Array<{ name: string; values: string[] }>;
}

const EU_ALLERGENS = [
  'Gluten',
  'Crustaceans',
  'Eggs',
  'Fish',
  'Peanuts',
  'Soybeans',
  'Milk',
  'Nuts',
  'Celery',
  'Mustard',
  'Sesame',
  'Sulphites',
  'Lupin',
  'Molluscs',
];

export const TEMPLATES: Template[] = [
  {
    key: 'apparel',
    name: 'Apparel',
    description: 'Clothing and accessories in sizes and colours.',
    fields: [
      {
        key: 'material',
        label: 'Material',
        type: 'single_select',
        level: 'both',
        options: ['Cotton', 'Organic cotton', 'Linen', 'Wool', 'Polyester', 'Viscose', 'Blend'],
        group: 'Details',
      },
      {
        key: 'care_instructions',
        label: 'Care instructions',
        type: 'rich_text',
        level: 'product',
        group: 'Details',
      },
      {
        key: 'gender',
        label: 'Fit',
        type: 'single_select',
        level: 'product',
        options: ['Women', 'Men', 'Unisex', 'Kids'],
        group: 'Details',
      },
    ],
    options: [
      { name: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      { name: 'Colour', values: ['Black', 'White', 'Grey', 'Navy', 'Red'] },
    ],
  },
  {
    key: 'furniture',
    name: 'Furniture',
    description: 'Large items, often shipped in several boxes.',
    fields: [
      {
        key: 'material',
        label: 'Material',
        type: 'single_select',
        level: 'both',
        options: ['Oak', 'Walnut', 'Pine', 'Beech', 'Metal', 'Glass', 'Fabric', 'Leather'],
        group: 'Details',
      },
      {
        key: 'finish',
        label: 'Finish',
        type: 'single_select',
        level: 'both',
        options: ['Natural', 'Oiled', 'Lacquered', 'Painted', 'Powder coated'],
        group: 'Details',
      },
      {
        key: 'assembled_width',
        label: 'Assembled width',
        type: 'measurement',
        level: 'both',
        config: { unitKind: 'length', defaultUnit: 'cm' },
        group: 'Assembled size',
      },
      {
        key: 'assembled_depth',
        label: 'Assembled depth',
        type: 'measurement',
        level: 'both',
        config: { unitKind: 'length', defaultUnit: 'cm' },
        group: 'Assembled size',
      },
      {
        key: 'assembled_height',
        label: 'Assembled height',
        type: 'measurement',
        level: 'both',
        config: { unitKind: 'length', defaultUnit: 'cm' },
        group: 'Assembled size',
      },
      {
        key: 'assembly_required',
        label: 'Assembly required',
        type: 'boolean',
        level: 'product',
        group: 'Details',
      },
    ],
    options: [
      { name: 'Colour', values: ['Natural', 'Black', 'White'] },
      { name: 'Size', values: ['Small', 'Medium', 'Large'] },
    ],
  },
  {
    key: 'food',
    name: 'Food',
    description: 'Food and drink with ingredients, allergens, and storage.',
    fields: [
      {
        key: 'net_weight',
        label: 'Net weight',
        type: 'measurement',
        level: 'variant',
        config: { unitKind: 'weight', defaultUnit: 'g' },
        required: true,
        group: 'Contents',
      },
      {
        key: 'ingredients',
        label: 'Ingredients',
        type: 'rich_text',
        level: 'product',
        group: 'Contents',
      },
      {
        key: 'allergens',
        label: 'Allergens',
        type: 'multi_select',
        level: 'product',
        options: EU_ALLERGENS,
        group: 'Contents',
      },
      {
        key: 'storage',
        label: 'Storage requirements',
        type: 'single_select',
        level: 'product',
        options: ['Ambient', 'Chilled', 'Frozen'],
        required: true,
        group: 'Storage',
      },
      {
        key: 'shelf_life_days',
        label: 'Shelf life (days)',
        type: 'integer',
        level: 'both',
        config: { min: '0', max: '3650' },
        group: 'Storage',
      },
    ],
    options: [{ name: 'Pack size', values: ['250 g', '500 g', '1 kg'] }],
  },
  {
    key: 'spare_parts',
    name: 'Spare parts',
    description: 'Parts with manufacturer numbers, replacements, and compatibility.',
    fields: [
      {
        key: 'manufacturer_number',
        label: 'Manufacturer number',
        type: 'text',
        level: 'variant',
        config: { maxLength: 100 },
        group: 'Identification',
      },
      {
        key: 'replaces',
        label: 'Replaces',
        type: 'relationship',
        level: 'variant',
        config: { targetType: 'variant', relationKind: 'replaces', maxItems: 50 },
        group: 'Compatibility',
      },
      {
        key: 'compatible_with',
        label: 'Compatible with',
        type: 'relationship',
        level: 'product',
        config: { targetType: 'product', relationKind: 'compatible_with', maxItems: 500 },
        group: 'Compatibility',
      },
      {
        key: 'condition',
        label: 'Condition',
        type: 'single_select',
        level: 'variant',
        options: ['New', 'Used', 'Refurbished'],
        required: true,
        group: 'Identification',
      },
    ],
    options: [],
  },
];

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key) as [Template['key'], ...Template['key'][]];

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import dedent from 'dedent';
import React, { useCallback } from 'react';
import { DegradedFieldMetadataResponse } from '../../../../common/data_streams_stats';
import { useKibanaContextForPlugin } from '../../../utils';

const ignoredAnalysisTitle = i18n.translate(
  'xpack.datasetQuality.flyout.degradedFields.ignoredAnalysis',
  {
    defaultMessage: 'Possible causes and remediations',
  }
);

export function Insights({ dataStream, field }: { dataStream: string; field: string }) {
  const {
    services: {
      observabilityAIAssistant: {
        ObservabilityAIAssistantContextualInsight,
        getContextualInsightMessages,
      } = {},
      http,
    },
  } = useKibanaContextForPlugin();

  const getDegradedFieldContextMessages = useCallback(async () => {
    if (!ObservabilityAIAssistantContextualInsight) {
      return [];
    }

    try {
      const { ignoredMetadata } = await http.get<DegradedFieldMetadataResponse>(
        `/internal/dataset_quality/data_streams/${dataStream}/ignored_metadata/${field}`
      );

      const doesMatchingDynamicTemplateExists =
        ignoredMetadata.mappings.possibleMatchingDynamicTemplates.length > 0;

      let dynamicTemplateMessage = '';
      const dynamicMappingFlag =
        ignoredMetadata.mappings.isDynamic === undefined || ignoredMetadata.mappings.isDynamic;

      if (doesMatchingDynamicTemplateExists) {
        dynamicTemplateMessage = dedent`
          The field ${field} has a matching dynamic template in the mappings.
          The dynamic templates are ${ignoredMetadata.mappings.possibleMatchingDynamicTemplates}.
        `;
      }

      return (
        getContextualInsightMessages &&
        getContextualInsightMessages({
          message: `Can you identify possible causes and remediation's for ${field} being ignored in the data stream - ${dataStream}?`,
          instructions: dedent(
            `I'm an SRE using Elastic stack. I am looking at a degraded field on ingestion side and I want to understand why it was ignored and what should I do next.

            You are an expert on Elastic Stack, who is being consulted about data set quality with respect to ignored fields in log datasets.

            "Data Set quality" is a concept based on the percentage of degraded documents in each data set.
            A degraded document in a data set contains the _ignored property because one or more of its fields were ignored during indexing.
            Fields are ignored for a variety of reasons -

            1. Data Type Mismatch: If the data type of the field in the document does not match the expected data type defined in the index mapping, Elasticsearch will ignore the field. For example, if a field is expected to be a number but a string is provided, it will be ignored.
            2. Malformed Data: If the data in the field is malformed and cannot be parsed according to the expected data type, it will be ignored. For instance, a date field with an invalid date format will be ignored.
            3. Field Length Exceeds Limit: Elasticsearch has limits on the length of fields, especially for text fields. If the content of a field exceeds these limits, it will be ignored.
            4. Array Field Issues: If a field is expected to be a single value but an array is provided, or if an array contains mixed data types that are not compatible with the field's mapping, the field may be ignored.
            5. Dynamic Mapping Conflicts: When dynamic mapping is enabled, if Elasticsearch encounters fields with conflicting types in different documents, it might ignore the fields that cause the conflict.
            6. Indexing Errors: General indexing errors, such as those caused by resource constraints or configuration issues, can result in fields being ignored.

            The above information is only for you. You can reference them but don't need to tell the user all this.

            Based on the provided contextual information below, help the SRE identify the exact root cause of why the ${field} field on ${dataStream} datastream was ignored and suggest possible remedies.
            Use the following contextual information to eliminate the possible reason so that you can narrow down to exact issue.

            ##Contextual Information

            The contextual Information below is classified into 3 categories: You can display this information to the user in a better co-related format which can help them eliminate the possible reasons for the field being ignored.

            1. Mappings Information:
            This information is retrieved from the GET ${dataStream}/_mapping and GET ${dataStream}/_field_caps API.

            The specific mapping for the field ${field} is ${JSON.stringify(
              ignoredMetadata.mappings.mappings
            )}.

            The total fields count for the dataStream is ${
              ignoredMetadata.mappings.fieldCount
            }, which is coming from fieldsCap API

            The dataStream mapping have a dynamic property set to ${dynamicMappingFlag}

            ${dynamicTemplateMessage}

            2. Settings Information:
            This information is retrieved from the GET ${dataStream}/_settings/ API.

            ignore_dynamic_beyond_limit:${ignoredMetadata.settings.ignoreDynamicBeyondLimit}
            ignore_malformed:${ignoredMetadata.settings.ignoreMalformed}

            The settings API too has mappings inside them - ${JSON.stringify(
              ignoredMetadata.settings.mappingInsideIndexSettings
            )}
            The total number of allowed fields is generally set here -  'settings.mappings.total_fields.limit',
            if you don't see this value inside mappings above, then it is not set and the default value is 1000.
            Please correlate this with the total fields count from mappings above.

            The following pipeline information is available from the settings API. Only display the available ones.
            No need to create panic in the users stating something is wrong here. Just inform them that they can possible check these pipelines too:
            default_pipeline:${ignoredMetadata.settings.pipelines.defaultPipeline}
            final_pipeline:${ignoredMetadata.settings.pipelines.finalPipeline}

            3. Templates Information:
            This information is retrieved from the GET /_index_template/${dataStream} and GET /_component_template/ API.

            The following index template information is available:
            index_template_name:${ignoredMetadata.templates.indexTemplateName}
            does_template_exist:${ignoredMetadata.templates.doesIndexTemplateExists}

            If the index templates exists, inform the user about its name and tell that they exists with this mapping and settings
            ${JSON.stringify(ignoredMetadata.templates.indexTemplateSettingsAndMappings)}

            See if these is anything in these setting which could cause the problem.

            The following component template information is available:
            component_template_name:${ignoredMetadata.templates.customComponentTemplates}
            the settings and mappings present inside the component templates are ${JSON.stringify(
              ignoredMetadata.templates.customComponentTemplatesSettingsAndMappings
            )}

            4. A sample latest Elasticsearch document with ${field} field ignored:
            ${JSON.stringify(ignoredMetadata.ignoredDocument)}
            Make sure you report the "_id" and ${field} field value from the document if present.

            The remediation must be based on the given context information, avoid generic remedies wherever possible.
            Always correlate the context information with the possible reasons for the field being ignored and suggest the remediation accordingly.
            Always consider the provided Sample Document and check it against the 1st 3 points provided to narrow down the root cause.

            At the end when providing "Suggested Remedies:", do not suggest solution which are not related to the context
            information provided above. Do not suggest checking pipelines in this section here.

            Always add a small section at the end of the result with the following message:
            Remember, any changes to the mapping will only affect new indices after a rollover. Existing indices will need to be
            re-indexed if you want the changes to apply to them.
          `
          ),
        })
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('An error occurred while fetching degradedField context', e);
      return (
        getContextualInsightMessages &&
        getContextualInsightMessages({
          message: `Can you identify possible causes and remediations for ${field} being ignored when ingesting documents in ${dataStream} datastream?`,
          instructions: dedent(
            `I'm an administrator using Elastic stack. I am looking at a degraded field on ingestion side and I want to understand why it was ignored and what should I do next`
          ),
        })
      );
    }
  }, [
    ObservabilityAIAssistantContextualInsight,
    dataStream,
    field,
    getContextualInsightMessages,
    http,
  ]);

  return ObservabilityAIAssistantContextualInsight ? (
    <ObservabilityAIAssistantContextualInsight
      title={ignoredAnalysisTitle}
      messages={getDegradedFieldContextMessages}
      openedByDefault={true}
    />
  ) : (
    <></>
  );
}

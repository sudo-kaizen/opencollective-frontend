import React from 'react';
import PropTypes from 'prop-types';
import { injectIntl, defineMessages, FormattedMessage } from 'react-intl';
import { graphql, compose } from 'react-apollo';
import gql from 'graphql-tag';
import { Flex } from '@rebass/grid';

import { CollectiveType } from '../lib/constants/collectives';

import ErrorPage from '../components/ErrorPage';
import Page from '../components/Page';
import { withStripeLoader } from '../components/StripeProvider';
import { withUser } from '../components/UserProvider';
import Loading from '../components/Loading';

import ContributionFlow from '../components/contribution-flow';
import MessageBox from '../components/MessageBox';

const messages = defineMessages({
  collectiveTitle: {
    id: 'CreateOrder.Title',
    defaultMessage: 'Contribute to {collective}',
  },
  eventTitle: {
    id: 'CreateOrder.TitleForEvent',
    defaultMessage: 'Order tickets for {event}',
  },
});

/**
 * Main contribution flow entrypoint. Render all the steps from contributeAs
 * to payment.
 */
class CreateOrderPage extends React.Component {
  static getInitialProps({ query }) {
    // Whitelist interval
    if (['monthly', 'yearly'].includes(query.interval)) {
      query.interval = query.interval.replace('ly', '');
    } else if (!['month', 'year'].includes(query.interval)) {
      query.interval = null;
    }

    if (query.data) {
      try {
        query.data = JSON.parse(query.data);
      } catch (err) {
        console.error(err);
      }
    }

    return {
      collectiveSlug: query.eventSlug || query.collectiveSlug,
      eventSlug: query.eventSlug,
      totalAmount: parseInt(query.amount) * 100 || parseInt(query.totalAmount) || null,
      step: query.step || 'contributeAs',
      tierId: parseInt(query.tierId) || null,
      tierSlug: query.tierSlug,
      quantity: parseInt(query.quantity) || 1,
      description: query.description ? decodeURIComponent(query.description) : undefined,
      interval: query.interval,
      verb: query.verb,
      redirect: query.redirect,
      referral: query.referral,
      customData: query.data,
    };
  }

  static propTypes = {
    collectiveSlug: PropTypes.string, // for addData
    eventSlug: PropTypes.string, // for addData
    tierSlug: PropTypes.string,
    tierId: PropTypes.number,
    quantity: PropTypes.number,
    totalAmount: PropTypes.number,
    interval: PropTypes.string,
    description: PropTypes.string,
    verb: PropTypes.string,
    step: PropTypes.string,
    customData: PropTypes.object,
    redirect: PropTypes.string,
    referral: PropTypes.string,
    data: PropTypes.object.isRequired, // from withData
    intl: PropTypes.object.isRequired, // from injectIntl
    loadStripe: PropTypes.func.isRequired, // from withStripeLoader
    LoggedInUser: PropTypes.object, // from withUser
    loadingLoggedInUser: PropTypes.bool, // from withUser
    createCollective: PropTypes.func,
    refetchLoggedInUser: PropTypes.func,
  };

  getPageMetadata() {
    const { intl, data } = this.props;

    if (!data || !data.Collective) {
      return { title: 'Contribute' };
    }

    const collective = data.Collective;
    return {
      description: collective.description,
      twitterHandle: collective.twitterHandle,
      image: collective.image || collective.backgroundImage,
      title:
        collective.type === CollectiveType.EVENT
          ? intl.formatMessage(messages.eventTitle, { event: collective.name })
          : intl.formatMessage(messages.collectiveTitle, { collective: collective.name }),
    };
  }

  renderPageContent() {
    const { data } = this.props;

    if (data.loading) {
      return (
        <Flex py={5} justifyContent="center">
          <Loading />
        </Flex>
      );
    } else if (!data.Collective.host) {
      return (
        <Flex py={5} justifyContent="center">
          <MessageBox type="info" withIcon>
            <FormattedMessage
              id="createOrder."
              defaultMessage="This collective doesn't have a host and can't accept donations"
            />
          </MessageBox>
        </Flex>
      );
    } else {
      const { verb, step, referral, redirect, description, quantity, interval, totalAmount } = this.props;
      return (
        <ContributionFlow
          collective={data.Collective}
          host={data.Collective.host}
          tier={data.Tier}
          verb={verb}
          step={step}
          referral={referral}
          redirect={redirect}
          description={description}
          defaultQuantity={quantity}
          interval={interval}
          fixedAmount={totalAmount}
        />
      );
    }
  }

  render() {
    const { data } = this.props;

    if (!data.loading && (!data || !data.Collective)) {
      return <ErrorPage data={data} />;
    } else {
      return <Page {...this.getPageMetadata()}>{this.renderPageContent()}</Page>;
    }
  }
}

const collectiveFields = `
  id
  slug
  name
  description
  longDescription
  twitterHandle
  type
  website
  image
  backgroundImage
  currency
  hostFeePercent
  tags
  settings
  location {
    country
  }
  host {
    id
    name
    settings
    location {
      country
    }
  }
  parentCollective {
    slug
    image
    settings
    location {
      country
    }
  }
`;

/* eslint-disable graphql/template-strings, graphql/no-deprecated-fields, graphql/capitalized-type-name, graphql/named-operations */
const CollectiveDataQuery = gql`
  query Collective($collectiveSlug: String!) {
    Collective(slug: $collectiveSlug) {
      ${collectiveFields}
    }
  }
`;

const CollectiveWithTierDataQuery = gql`
  query CollectiveWithTier($collectiveSlug: String!, $tierId: Int!) {
    Collective(slug: $collectiveSlug) {
      ${collectiveFields}
    }
    Tier(id: $tierId) {
      id
      type
      name
      slug
      description
      amount
      minimumAmount
      currency
      interval
      presets
      customFields
      maxQuantity
      stats {
        availableQuantity
      }
    }
  }
`;

const addGraphQL = compose(
  graphql(CollectiveDataQuery, { skip: props => props.tierId }),
  graphql(CollectiveWithTierDataQuery, { skip: props => !props.tierId }),
);

export default injectIntl(addGraphQL(withUser(withStripeLoader(CreateOrderPage))));
